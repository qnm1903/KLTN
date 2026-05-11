import { ethers } from 'ethers';
import { canTransitionStatus } from '../lib/escrow-status.js';
import { factoryAbi, vaultAbi, mediatorPoolAbi } from '../abi.js';
import { emitToEscrow } from '../lib/socket-emitter.js';
import { io as ioClient } from 'socket.io-client';
let socketClient = null; 

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONFIRM_DEADLINE_DAYS = Number(process.env.CONFIRM_DEADLINE_DAYS ?? 7);
const TIMEOUT_DEADLINE_DAYS = Number(process.env.TIMEOUT_DEADLINE_DAYS ?? 14);

function normalizeAddress(value) {
  if (!value) return null;
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function buildDeadlineFromNow(days) {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + Math.floor(days) * MS_PER_DAY);
}

async function findEscrowByChainContext(prisma, escrowId, contractAddress) {
  return prisma.escrow.findFirst({
    where: {
      OR: [
        { chainEscrowId: escrowId },
        { contractAddress: contractAddress ?? undefined }
      ]
    },
    include: {
      buyer: { select: { walletAddress: true } },
      seller: { select: { walletAddress: true } }
    }
  });
}

async function updateEscrowStatus(prisma, escrow, nextStatus, data = {}) {
  if (!canTransitionStatus(escrow.status, nextStatus)) {
    console.warn(`[websocket] Invalid status transition from ${escrow.status} to ${nextStatus}`);
    return false;
  }

  const updated = await prisma.escrow.updateMany({
    where: {
      id: escrow.id,
      status: escrow.status
    },
    data: {
      status: nextStatus,
      ...data
    }
  });

  return updated.count === 1;
}

async function handleFactoryCreated(prisma, args, contractAddress, logger) {
  const vaultAddress = normalizeAddress(args.escrowAddress);
  const escrowId = args.escrowId;
  const buyer = normalizeAddress(args.buyer);
  const seller = normalizeAddress(args.seller);

  let escrow = await prisma.escrow.findFirst({
    where: {
      OR: [
        { chainEscrowId: escrowId },
        { contractAddress: vaultAddress }
      ]
    },
    include: {
      buyer: { select: { walletAddress: true } },
      seller: { select: { walletAddress: true } }
    }
  });

  if (!escrow) {
    escrow = await prisma.escrow.findFirst({
      where: {
        chainEscrowId: null,
        contractAddress: null,
        buyer: { walletAddress: buyer },
        seller: { walletAddress: seller }
      },
      include: {
        buyer: { select: { walletAddress: true } },
        seller: { select: { walletAddress: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  if (!escrow) {
    logger?.warn?.(`[websocket] No matching escrow found for factory event escrowId=${escrowId}`);
    return { vaultAddress };
  }

  const updated = await updateEscrowStatus(prisma, escrow, 'INITIALIZED', {
    chainEscrowId: escrowId,
    contractAddress: vaultAddress,
    confirmDeadline: buildDeadlineFromNow(CONFIRM_DEADLINE_DAYS)
  });

  if (updated) {
    logger?.info?.(`[websocket] Updated escrow ${escrowId} to INITIALIZED`);
  }

  return { vaultAddress };
}

async function handleVaultEvent(prisma, eventName, args, contractAddress, logger) {
  const escrowId = args.escrowId;
  const escrow = await findEscrowByChainContext(prisma, escrowId, contractAddress);

  if (!escrow) {
    logger?.warn?.(`[websocket] No matching escrow found for vault event escrowId=${escrowId}`);
    return;
  }

  if (eventName === 'EscrowCreated') {
    const updated = await updateEscrowStatus(prisma, escrow, 'INITIALIZED', {
      chainEscrowId: escrowId,
      contractAddress,
      confirmDeadline: buildDeadlineFromNow(CONFIRM_DEADLINE_DAYS)
    });
    if (updated) {
      logger?.info?.(`[websocket] Updated escrow ${escrowId} to INITIALIZED`);
    }
    return;
  }

  if (eventName === 'FundsLocked') {
    const updated = await updateEscrowStatus(prisma, escrow, 'LOCKED', {
      timeoutDeadline: buildDeadlineFromNow(TIMEOUT_DEADLINE_DAYS)
    });
    if (updated) {
      logger?.info?.(`[websocket] Updated escrow ${escrowId} to LOCKED`);
    }
    return;
  }

  if (eventName === 'DisputeOpened') {
    const updated = await updateEscrowStatus(prisma, escrow, 'DISPUTED');
    if (updated) {
      logger?.info?.(`[websocket] Updated escrow ${escrowId} to DISPUTED`);
    }
    return;
  }

  if (eventName === 'FundsReleased') {
    const recipient = normalizeAddress(args.recipient);
    const isRefund = recipient === normalizeAddress(escrow.buyer.walletAddress);
    const nextStatus = isRefund ? 'REFUNDED' : 'RELEASED';
    const updated = await updateEscrowStatus(prisma, escrow, nextStatus);
    if (updated) {
      logger?.info?.(`[websocket] Updated escrow ${escrowId} to ${nextStatus}`);
    }
  }
}

async function handleRandomMediatorSelected(prisma, escrowId, mediators, logger) {
  try {
    const escrowIdHex = escrowId;

    const escrow = await prisma.escrow.findFirst({
      where: { chainEscrowId: escrowIdHex },
      select: { id: true, status: true }
    });

    if (!escrow) {
      logger?.warn?.(`[mediator-pool] No escrow found for chainEscrowId=${escrowIdHex}`);
      return;
    }

    const records = [];
    for (let i = 0; i < mediators.length; i++) {
      const addr = normalizeAddress(mediators[i]);
      if (!addr) continue;

      // Ensure the on-chain address exists as a User (idempotent)
      const user = await prisma.user.upsert({
        where: { walletAddress: addr },
        update: { isMediator: true, role: 'MEDIATOR' },
        create: { walletAddress: addr, role: 'MEDIATOR', isMediator: true },
        select: { id: true }
      });

      records.push({
        escrowId: escrow.id,
        mediatorId: user.id,
        slot: i + 1
      });
    }

    if (records.length > 0) {
      logger?.info?.(`[mediator-pool] Saving ${records.length} mediators to DB...`);
      
      // Upsert EscrowMediator entries idempotently (handle P2002 races)
      for (const record of records) {
        try {
          await prisma.escrowMediator.upsert({
            where: {
              escrowId_slot: {
                escrowId: record.escrowId,
                slot: record.slot
              }
            },
            update: {
              mediatorId: record.mediatorId
            },
            create: record
          });
          logger?.info?.(`[mediator-pool] Upserted escrowMediator slot ${record.slot} for escrow ${record.escrowId}`);
        } catch (error) {
          if (error?.code === 'P2002') {
            logger?.warn?.(`[mediator-pool] Duplicate escrowMediator slot ${record.slot} for escrow ${record.escrowId}, skipping`);
            continue;
          }
          logger?.error?.(`[mediator-pool] Database error saving mediator: ${error.message || error}`);
        }
      }

      // If there's an active dispute for this escrow, upsert DisputeMediator links
      const activeDispute = await prisma.dispute.findFirst({
        where: { escrowId: escrow.id, status: { not: 'RESOLVED' } },
        orderBy: { createdAt: 'desc' }
      });

      if (activeDispute) {
        logger?.info?.(`[mediator-pool] Found active dispute ${activeDispute.id}, assigning mediators to dispute`);
        for (const record of records) {
          try {
            await prisma.disputeMediator.upsert({
              where: {
                disputeId_mediatorId: {
                  disputeId: activeDispute.id,
                  mediatorId: record.mediatorId
                }
              },
              update: {
                slot: record.slot,
                status: 'assigned'
              },
              create: {
                disputeId: activeDispute.id,
                mediatorId: record.mediatorId,
                slot: record.slot,
                status: 'assigned'
              }
            });
            logger?.info?.(`[mediator-pool] Upserted DisputeMediator mediatorId=${record.mediatorId} slot=${record.slot} dispute=${activeDispute.id}`);
          } catch (error) {
            if (error?.code === 'P2002') {
              logger?.warn?.(`[mediator-pool] Duplicate dispute mediator for dispute ${activeDispute.id} mediator ${record.mediatorId}, skipping`);
              continue;
            }
            logger?.error?.(`[mediator-pool] Error upserting DisputeMediator: ${error.message || error}`);
          }
        }

        // Move dispute to VOTING (or appropriate next state) and set assignedAt if not set
        try {
          await prisma.dispute.update({
            where: { id: activeDispute.id },
            data: { status: 'VOTING', assignedAt: new Date() }
          });
          logger?.info?.(`[mediator-pool] Updated Dispute ${activeDispute.id} status to VOTING`);
        } catch (err) {
          logger?.error?.(`[mediator-pool] Failed to update dispute status: ${err.message || err}`);
        }
      }

      // Update escrow flags so the UI can show mediators are selected
      try {
        await prisma.escrow.update({
          where: { id: escrow.id },
          data: {
            mediatorPoolUsed: true,
            mediatorsSelectedAt: new Date(),
            // If this event should also mark escrow as DISPUTED (depending on flow), don't forcibly overwrite:
            // only set status if it's already DISPUTED or leave it as-is. Here we keep it unchanged.
          }
        });
      } catch (err) {
        logger?.warn?.(`[mediator-pool] Failed to update escrow mediator flags: ${err.message || err}`);
      }

      logger?.info?.(`[mediator-pool] Successfully saved mediators for escrow ${escrow.id}`);
    }

    // Worker báo cáo cho Backend Server thông qua Socket Client (Thay thế cho emitToEscrow bị lỗi)
    try {
      if (socketClient && socketClient.connected) {
        socketClient.emit('worker:mediators_selected', {
          escrowId: escrow.id,
          chainEscrowId: escrowIdHex,
          mediators: mediators.map(m => normalizeAddress(m)),
          count: records.length
        });
        logger?.info?.('[mediator-pool] Đã bắn sự kiện worker:mediators_selected tới Backend');
      } else {
        logger?.warn?.('[mediator-pool] Socket client chưa kết nối, không thể báo cho Backend.');
      }
    } catch (err) {
      logger?.warn?.('[mediator-pool] Lỗi khi bắn sự kiện tới Backend:', err?.message || err);
    }
  } catch (error) {
    logger?.error?.('[mediator-pool] Failed to handle RandomMediatorSelected:', error?.message ?? error);
  }
}

export function startWebSocketEventListener({ prisma, logger = console, config = {} }) {
  const rpcUrl = config.rpcUrl ?? process.env.WS_RPC_URL ?? process.env.RPC_URL;
  const factoryAddressRaw = config.factoryAddress ?? process.env.FACTORY_ADDRESS;
  const mediatorPoolAddressRaw = config.mediatorPoolAddress ?? process.env.MEDIATOR_POOL_CONTRACT;
  const confirmations = Number(config.confirmations ?? process.env.LISTENER_CONFIRMATIONS ?? 6);

  if (!rpcUrl || !factoryAddressRaw) {
    throw new Error('WS_RPC_URL and FACTORY_ADDRESS are required to run WebSocket event listener.');
  }

  const factoryAddress = normalizeAddress(factoryAddressRaw);
  const mediatorPoolAddress = normalizeAddress(mediatorPoolAddressRaw);
  const provider = new ethers.WebSocketProvider(rpcUrl);
  const factoryContract = new ethers.Contract(factoryAddress, factoryAbi, provider);

  // Khởi tạo Socket Client để giao tiếp với Backend
  try {
    const backendUrl = process.env.BACKEND_WS_URL || `http://localhost:${process.env.PORT || 3001}`;
    socketClient = ioClient(backendUrl, { reconnectionAttempts: 5, reconnectionDelay: 2000, transports: ['websocket'] });

    socketClient.on('connect', () => {
      logger?.info?.(`[websocket-worker] Đã kết nối với Backend Socket tại ${backendUrl}`);
    });

    // Lắng nghe lệnh từ Backend: "Có Hợp đồng mới, hãy theo dõi nó đi!"
    socketClient.on('subscribe_vault', async (payload) => {
      try {
        if (payload?.contractAddress) {
          logger?.info?.(`[websocket-worker] Backend yêu cầu theo dõi Vault mới: ${payload.contractAddress}`);
          await subscribeToVault(payload.contractAddress);
        }
      } catch (err) {
        logger?.error?.('[websocket-worker] Lỗi khi subscribe_vault:', err?.message || err);
      }
    });
  } catch (err) {
    logger?.warn?.('[websocket-worker] Không thể khởi tạo Socket Client:', err?.message || err);
  }

  // Subscribe to MediatorPool events
  if (mediatorPoolAddress) {
    const mediatorPoolContract = new ethers.Contract(mediatorPoolAddress, mediatorPoolAbi, provider);

    mediatorPoolContract.on('RandomMediatorSelected', async (escrowId, mediators, event) => {
      if (event.logIndex < confirmations) return;
      await handleRandomMediatorSelected(prisma, escrowId, mediators, logger);
    });

    logger?.info?.(`[websocket] Subscribed to MediatorPool: ${mediatorPoolAddress}`);
  } else {
    logger?.warn?.('[websocket] MEDIATOR_POOL_CONTRACT not set, skipping MediatorPool listener');
  }

  const knownVaults = new Map(); // vaultAddress -> contract instance
  let running = true;

  async function subscribeToVault(vaultAddress) {
    if (knownVaults.has(vaultAddress)) return;

    const vaultContract = new ethers.Contract(vaultAddress, vaultAbi, provider);
    knownVaults.set(vaultAddress, vaultContract);

    // Subscribe to vault events
    vaultContract.on('EscrowCreated', (escrowId, buyer, seller, amount, event) => {
      if (event.logIndex >= confirmations) {
        handleVaultEvent(prisma, 'EscrowCreated', { escrowId }, vaultAddress, logger);
      }
    });

    vaultContract.on('FundsLocked', (escrowId, amount, event) => {
      if (event.logIndex >= confirmations) {
        handleVaultEvent(prisma, 'FundsLocked', { escrowId }, vaultAddress, logger);
      }
    });

    vaultContract.on('DisputeOpened', (escrowId, event) => {
      if (event.logIndex >= confirmations) {
        handleVaultEvent(prisma, 'DisputeOpened', { escrowId }, vaultAddress, logger);
      }
    });

    vaultContract.on('FundsReleased', (escrowId, recipient, signerBitmap, action, event) => {
      if (event.logIndex >= confirmations) {
        handleVaultEvent(prisma, 'FundsReleased', { escrowId, recipient }, vaultAddress, logger);
      }
    });

    logger?.info?.(`[websocket] Subscribed to vault: ${vaultAddress}`);
  }

  // Subscribe to Factory events
  factoryContract.on('EscrowCreatedEvent', async (escrowAddress, escrowId, buyer, seller, mediators, event) => {
    if (event.logIndex < confirmations) return;

    const result = await handleFactoryCreated(prisma, {
      escrowAddress,
      escrowId,
      buyer,
      seller
    }, factoryAddress, logger);

    if (result?.vaultAddress) {
      await subscribeToVault(result.vaultAddress);
    }
  });

  // Subscribe to existing vaults from database
  async function subscribeToExistingVaults() {
    const escrows = await prisma.escrow.findMany({
      where: { contractAddress: { not: null } },
      select: { contractAddress: true }
    });

    for (const escrow of escrows) {
      if (escrow.contractAddress) {
        await subscribeToVault(normalizeAddress(escrow.contractAddress));
      }
    }
  }

  subscribeToExistingVaults().catch(error => {
    logger?.error?.('[websocket] Failed to subscribe to existing vaults:', error.message);
  });

  logger?.info?.(`[websocket] Event listener started, listening to Factory: ${factoryAddress}`);

  // Handle WebSocket connection errors
  if (provider.websocket) {
    provider.websocket.onerror = (error) => {
      logger?.error?.('[websocket] WebSocket error:', error.message);
    };
  }

  return {
    async stop() {
      running = false;
      provider.removeAllListeners();
      await provider.destroy();
      logger?.info?.('[websocket] Event listener stopped');
    }
  };
}
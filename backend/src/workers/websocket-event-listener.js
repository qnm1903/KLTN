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
  const escrow = await prisma.escrow.findFirst({
    where: { chainEscrowId: escrowId }, // lookup bằng chainEscrowId đã được set ở bước 2
    select: { id: true, status: true }
  });
  if (!escrow) { logger?.warn?.(`[mediator-pool] No escrow found for chainEscrowId=${escrowId}`); return; }

  for (let i = 0; i < mediators.length; i++) {
    const addr = normalizeAddress(mediators[i]);
    const user = await prisma.user.upsert({
      where: { walletAddress: addr },
      update: { isMediator: true, role: 'MEDIATOR' },
      create: { walletAddress: addr, role: 'MEDIATOR', isMediator: true },
      select: { id: true }
    });

    // CHỈ ghi EscrowMediator — source of truth duy nhất
    await prisma.escrowMediator.upsert({
      where: { escrowId_slot: { escrowId: escrow.id, slot: i + 1 } },
      update: { mediatorId: user.id },
      create: { escrowId: escrow.id, mediatorId: user.id, slot: i + 1 }
    });
  }

  // KHÔNG ghi DisputeMediator ở đây
  // KHÔNG update dispute status ở đây

  emitToEscrow(escrow.id, 'mediators_selected', {
    escrowId: escrow.id,
    mediators: mediators.map(m => normalizeAddress(m)),
    readyForDkg: true
  });

  logger?.info?.(`[mediator-pool] Assigned ${mediators.length} mediators to escrow ${escrow.id}`);
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
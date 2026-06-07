import { ethers } from 'ethers';
import * as secp from '@noble/secp256k1';
import jwt from 'jsonwebtoken';
import { canTransitionStatus } from '../lib/escrow-status.js';
import { factoryAbi, vaultAbi, mediatorPoolAbi } from '../abi.js';
import { emitToEscrow } from '../lib/socket-emitter.js';
import { io as ioClient } from 'socket.io-client';
let socketClient = null;
const dkgProcessingLocks = new Set();
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

function normalizeBytes32(value) {
  if (!value) return null;
  const cleanValue = typeof value === 'string' ? value : value.toString();
  return cleanValue.toLowerCase().trim();
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
        //chainEscrowId: null,
        contractAddress: null,
        buyer: { walletAddress: buyer },
        seller: { walletAddress: seller },
        status: { in: ['DRAFT', 'MEDIATORS_ASSIGNED'] }
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
    return;
  }

  if (eventName === 'FundsSplit') {
    const updated = await updateEscrowStatus(prisma, escrow, 'RELEASED');
    if (updated) {
      logger?.info?.(`[websocket] Updated escrow ${escrowId} to RELEASED via split payout`);
    }
  }
}

async function handleRandomMediatorSelected(prisma, escrowId, mediators, logger, factoryContract) {
  const normalizedChainEscrowId = normalizeBytes32(escrowId);
  logger?.info?.(`[DKG-ORCHESTRATOR] Searching database for normalized chainEscrowId: ${normalizedChainEscrowId}`);

  const escrow = await prisma.escrow.findFirst({
    where: {
      OR: [
        { chainEscrowId: normalizedChainEscrowId },
        { chainEscrowId: escrowId }
      ]
    },
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
  if (socketClient && socketClient.connected) {
    socketClient.emit('mediators_selected', {
      escrowId: escrow.id,
      mediators: mediators.map(m => normalizeAddress(m)),
      readyForDkg: true
    });
  } else {
    logger?.warn?.(`[Socket] socketClient chưa kết nối, không thể phát sự kiện mediators_selected cho Escrow ${escrow.id}`);
  }

  logger?.info?.(`[mediator-pool] Assigned ${mediators.length} mediators to escrow ${escrow.id}`);

  setTimeout(async () => {
    if (dkgProcessingLocks.has(escrow.id)) {
      logger?.warn?.(`[DKG-ORCHESTRATOR] Bỏ qua luồng DKG trùng lặp cho Escrow ID: ${escrow.id}`);
      return;
    }
    dkgProcessingLocks.add(escrow.id);

    try {
      const baseUrl = `http://localhost:${process.env.PORT || 3001}/api`;
      logger?.info?.(`[mediator-pool] [DKG-ORCHESTRATOR] Khởi tạo luồng DKG cho Escrow ID: ${escrow.id}`);

      // 1. Lấy thông tin Escrow từ DB (bao gồm cả wallet address của buyer/seller)
      const escrowFresh = await prisma.escrow.findUnique({
        where: { id: escrow.id },
        select: {
          contractAddress: true,
          buyer: { select: { walletAddress: true } },
          seller: { select: { walletAddress: true } }
        }
      });

      // Prisma tự JOIN sang bảng User để lấy walletAddress
      // (DB chỉ lưu buyerId/sellerId là UUID — không phải wallet address trực tiếp)
      if (!escrowFresh) throw new Error(`Không tìm thấy escrow ${escrow.id} trong DB`);

      const buyerWalletAddress = normalizeAddress(escrowFresh.buyer?.walletAddress);
      const sellerWalletAddress = normalizeAddress(escrowFresh.seller?.walletAddress);
      if (!buyerWalletAddress || !sellerWalletAddress) {
        throw new Error(`Thiếu wallet address của buyer hoặc seller cho escrow ${escrow.id}`);
      }

      const resolvedContractAddress = escrowFresh.contractAddress || null;
      if (!resolvedContractAddress) {
        logger?.info?.(`[DKG-ORCHESTRATOR] contractAddress chưa có (Vault chưa deploy). Tiếp tục chạy DKG...`);
      }

      // 2. MỞ PHIÊN DKG (POST /escrow/init) - Bắt buộc để vượt qua rào chặn hasSession()
      // Chỉ gửi escrowId + chainId + contractAddress để backend chạy nhánh INCREMENTAL DKG
      // (tự resolve participants từ DB). KHÔNG gửi addr fields — chúng kích nhánh "batch" vốn
      // bắt buộc kèm pubKeys (pubkey chỉ sinh sau ở DKG B1) → gây 400 "Missing required fields".
      const initUrl = `${baseUrl}/escrow/init`;
      const initPayload = {
        escrowId: escrow.id,
        chainId: process.env.CHAIN_ID || "11155111",
        contractAddress: resolvedContractAddress,
      };

      logger?.info?.(`[DKG-ORCHESTRATOR] Init payload: escrowId=${escrow.id}, chainId=${initPayload.chainId} (incremental DKG, participants resolved from DB)`);


      logger?.info?.(`[mediator-pool] [DKG-ORCHESTRATOR] Gọi API Khởi tạo phiên DKG...`);
      const initRes = await fetch(initUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initPayload)
      });

      if (!initRes.ok) {
        const initErrText = await initRes.text();
        if (initRes.status === 409) {
          logger?.warn?.(`[mediator-pool] [DKG-ORCHESTRATOR] Phiên DKG đã tồn tại (HTTP 409). Bỏ qua khởi tạo...`);
        } else {
          throw new Error(`Khởi tạo phiên DKG thất bại (HTTP ${initRes.status}): ${initErrText}`);
        }
      } else {
        logger?.info?.(`[mediator-pool] [DKG-ORCHESTRATOR] 🎉 Phiên DKG đã được mở thành công trên RAM Backend!`);
      }
    } catch (err) {
      logger?.error?.(`[mediator-pool] [CRITICAL FLUID BREAK] Thất bại tại luồng phối hợp DKG: ${err.message}`);
    } finally {
      setTimeout(() => dkgProcessingLocks.delete(escrow.id), 60000);
    }
  }, 2500);
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
      try {
        logger.info(`[websocket] Bắt được event RandomMediatorSelected cho Escrow: ${escrowId}`);
        await handleRandomMediatorSelected(prisma, escrowId, mediators, logger, factoryContract);
      } catch (err) {
        logger.error('[websocket] RandomMediatorSelected handler error', err?.message ?? err);
      }
    });

    // Active polling fallback routine to mitigate silent WebSocket connection drops
    const processedEvents = new Set();
    setInterval(async () => {
      try {
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - 30); // Scanning past 30 blocks (~5-7 mins latency window)

        // Fetch logs in chunks to comply with free tier RPC limits (e.g. 10 block max range)
        const logs = [];
        const CHUNK_SIZE = 9; // Range of 10 blocks (start + 9 = 10 blocks inclusive)
        for (let start = fromBlock; start <= currentBlock; start += CHUNK_SIZE + 1) {
          const end = Math.min(start + CHUNK_SIZE, currentBlock);
          const chunkLogs = await mediatorPoolContract.queryFilter('RandomMediatorSelected', start, end);
          logs.push(...chunkLogs);
        }
        for (const log of logs) {
          if (log.args && log.transactionHash) {
            const eventKey = `${log.transactionHash}-${log.index}`;
            if (!processedEvents.has(eventKey)) {
              processedEvents.add(eventKey);
              const [eId, meds] = log.args;
              logger?.warn?.(`[websocket-fallback] Discovered missed event via queryFilter. TxHash: ${log.transactionHash}`);
              await handleRandomMediatorSelected(prisma, eId, meds, logger, factoryContract);
            }
          }
        }
        if (processedEvents.size > 500) processedEvents.clear(); // Flush cache to avoid memory leaks
      } catch (pollErr) {
        logger?.error?.(`[websocket-fallback] Active log scanning routine failed: ${pollErr.message}`);
      }
    }, 20000); // Trigger robust verification every 20 seconds

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
    vaultContract.on('EscrowCreated', async (escrowId, buyer, seller, amount, event) => {
      try {
        logger?.info?.(`[websocket] Bắt được event Vault EscrowCreated: ${escrowId}`);
        await handleVaultEvent(prisma, 'EscrowCreated', { escrowId }, vaultAddress, logger);
      } catch (err) {
        logger?.error?.('[websocket] Vault EscrowCreated handler error', err?.message ?? err);
      }
    });

    vaultContract.on('FundsLocked', async (escrowId, amount, event) => {
      try {
        logger?.info?.(`[websocket] Bắt được event Vault FundsLocked: ${escrowId}`);
        await handleVaultEvent(prisma, 'FundsLocked', { escrowId }, vaultAddress, logger);
      } catch (err) {
        logger?.error?.('[websocket] Vault FundsLocked handler error', err?.message ?? err);
      }
    });

    vaultContract.on('DisputeOpened', async (escrowId, event) => {
      try {
        logger?.info?.(`[websocket] Bắt được event Vault DisputeOpened: ${escrowId}`);
        await handleVaultEvent(prisma, 'DisputeOpened', { escrowId }, vaultAddress, logger);
      } catch (err) {
        logger?.error?.('[websocket] Vault DisputeOpened handler error', err?.message ?? err);
      }
    });

    vaultContract.on('FundsReleased', async (escrowId, recipient, signerBitmap, action, event) => {
      try {
        logger?.info?.(`[websocket] Bắt được event Vault FundsReleased: ${escrowId}`);
        await handleVaultEvent(prisma, 'FundsReleased', { escrowId, recipient }, vaultAddress, logger);
      } catch (err) {
        logger?.error?.('[websocket] Vault FundsReleased handler error', err?.message ?? err);
      }
    });

    vaultContract.on('FundsSplit', async (escrowId, buyer, seller, buyerAmount, sellerAmount, signerBitmap, event) => {
      try {
        logger?.info?.(`[websocket] Bắt được event Vault FundsSplit: ${escrowId}`);
        await handleVaultEvent(prisma, 'FundsSplit', { escrowId, buyer, seller, buyerAmount, sellerAmount }, vaultAddress, logger);
      } catch (err) {
        logger?.error?.('[websocket] Vault FundsSplit handler error', err?.message ?? err);
      }
    });

    logger?.info?.(`[websocket] Subscribed to vault: ${vaultAddress}`);
  }

  // Subscribe to Factory events
  factoryContract.on('EscrowCreatedEvent', async (escrowAddress, escrowId, buyer, seller, mediators, event) => {
    try {
      logger.info(`[websocket] Bắt được event EscrowCreatedEvent cho Escrow: ${escrowId}`);
      const result = await handleFactoryCreated(prisma, {
        escrowAddress,
        escrowId,
        buyer,
        seller
      }, factoryAddress, logger);

      if (result?.vaultAddress) {
        await subscribeToVault(result.vaultAddress);
      }
    } catch (err) {
      logger.error('[websocket] EscrowCreatedEvent handler error', err?.message ?? err);
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
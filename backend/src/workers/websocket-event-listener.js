import { ethers } from 'ethers';
import { canTransitionStatus } from '../lib/escrow-status.js';
import { factoryAbi, vaultAbi } from '../abi.js';

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

export function startWebSocketEventListener({ prisma, logger = console, config = {} }) {
  const rpcUrl = config.rpcUrl ?? process.env.WS_RPC_URL ?? process.env.RPC_URL;
  const factoryAddressRaw = config.factoryAddress ?? process.env.FACTORY_ADDRESS;
  const confirmations = Number(config.confirmations ?? process.env.LISTENER_CONFIRMATIONS ?? 6);

  if (!rpcUrl || !factoryAddressRaw) {
    throw new Error('WS_RPC_URL and FACTORY_ADDRESS are required to run WebSocket event listener.');
  }

  const factoryAddress = normalizeAddress(factoryAddressRaw);
  const provider = new ethers.WebSocketProvider(rpcUrl);
  const factoryContract = new ethers.Contract(factoryAddress, factoryAbi, provider);

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
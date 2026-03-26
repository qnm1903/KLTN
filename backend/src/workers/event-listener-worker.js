import { ethers } from 'ethers';
import { canTransitionStatus } from '../lib/escrow-status.js';

const FACTORY_ABI = [
  'event EscrowCreatedEvent(address indexed escrowAddress, bytes32 indexed escrowId, address indexed buyer, address seller)'
];

const VAULT_ABI = [
  'event EscrowCreated(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount)',
  'event FundsLocked(bytes32 indexed escrowId, uint256 amount)',
  'event FundsReleased(bytes32 indexed escrowId, address indexed recipient)',
  'event DisputeOpened(bytes32 indexed escrowId)'
];

const SYNC_STATE_KEY = 'event-listener-v1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONFIRM_DEADLINE_DAYS = Number(process.env.CONFIRM_DEADLINE_DAYS ?? 7);
const TIMEOUT_DEADLINE_DAYS = Number(process.env.TIMEOUT_DEADLINE_DAYS ?? 14);

function buildDeadlineFromNow(days) {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + Math.floor(days) * MS_PER_DAY);
}

// Returns null when the chain log index is missing.
export function getLogIndex(log) {
  const rawIndex = log?.index ?? log?.logIndex;
  if (rawIndex == null) return null;

  const normalizedIndex = Number(rawIndex);
  return Number.isFinite(normalizedIndex) ? normalizedIndex : null;
}

function getTxHash(log) {
  return log.transactionHash ?? log.txHash;
}

async function ensureSyncState(prisma, startBlock) {
  return prisma.eventSyncState.upsert({
    where: { key: SYNC_STATE_KEY },
    update: {},
    create: {
      key: SYNC_STATE_KEY,
      lastProcessedBlock: startBlock
    }
  });
}

async function isProcessed(prisma, txHash, logIndex) {
  const found = await prisma.processedChainEvent.findUnique({
    where: {
      txHash_logIndex: { txHash, logIndex }
    }
  });
  return Boolean(found);
}

async function markProcessed(prisma, payload) {
  await prisma.processedChainEvent.create({ data: payload });
}

function normalizeAddress(value) {
  if (!value) return null;
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
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

async function handleFactoryCreated({ prisma, args, contractAddress, logger }) {
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
    logger.warn?.(`[listener] No matching escrow found for factory event escrowId=${escrowId}`);
    return { vaultAddress };
  }

  await updateEscrowStatus(prisma, escrow, 'INITIALIZED', {
    chainEscrowId: escrowId,
    contractAddress: vaultAddress,
    confirmDeadline: buildDeadlineFromNow(CONFIRM_DEADLINE_DAYS)
  });

  return { vaultAddress };
}

async function handleVaultEvent({ prisma, parsedLog, contractAddress }) {
  const eventName = parsedLog.name;
  const args = parsedLog.args;
  const escrowId = args.escrowId;

  const escrow = await findEscrowByChainContext(prisma, escrowId, contractAddress);
  if (!escrow) {
    return;
  }

  if (eventName === 'EscrowCreated') {
    await updateEscrowStatus(prisma, escrow, 'INITIALIZED', {
      chainEscrowId: escrowId,
      contractAddress,
      confirmDeadline: buildDeadlineFromNow(CONFIRM_DEADLINE_DAYS)
    });
    return;
  }

  if (eventName === 'FundsLocked') {
    await updateEscrowStatus(prisma, escrow, 'LOCKED', {
      timeoutDeadline: buildDeadlineFromNow(TIMEOUT_DEADLINE_DAYS)
    });
    return;
  }

  if (eventName === 'DisputeOpened') {
    await updateEscrowStatus(prisma, escrow, 'DISPUTED');
    return;
  }

  if (eventName === 'FundsReleased') {
    const recipient = normalizeAddress(args.recipient);
    const isRefund = recipient === normalizeAddress(escrow.buyer.walletAddress);
    const nextStatus = isRefund ? 'REFUNDED' : 'RELEASED';
    await updateEscrowStatus(prisma, escrow, nextStatus);
  }
}

export function startEventListenerWorker({ prisma, logger = console, config = {} }) {
  const rpcUrl = config.rpcUrl ?? process.env.RPC_URL;
  const factoryAddressRaw = config.factoryAddress ?? process.env.CONTRACT_ADDRESS;
  const confirmations = Number(config.confirmations ?? process.env.LISTENER_CONFIRMATIONS ?? 6);
  const pollIntervalMs = Number(config.pollIntervalMs ?? process.env.LISTENER_POLL_INTERVAL_MS ?? 12_000);
  const blockBatchSize = Number(config.blockBatchSize ?? process.env.LISTENER_BLOCK_BATCH_SIZE ?? 1000);
  const startBlock = Number(config.startBlock ?? process.env.LISTENER_START_BLOCK ?? 0);

  if (!rpcUrl || !factoryAddressRaw) {
    throw new Error('RPC_URL and CONTRACT_ADDRESS are required to run event listener worker.');
  }

  const factoryAddress = normalizeAddress(factoryAddressRaw);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const factoryInterface = new ethers.Interface(FACTORY_ABI);
  const vaultInterface = new ethers.Interface(VAULT_ABI);
  const knownVaults = new Set();

  let running = true;
  let loopPromise;

  async function processFactoryLogs(fromBlock, toBlock) {
    const logs = await provider.getLogs({
      address: factoryAddress,
      fromBlock,
      toBlock,
      topics: [factoryInterface.getEvent('EscrowCreatedEvent').topicHash]
    });

    for (const log of logs) {
      const txHash = getTxHash(log);
      const logIndex = getLogIndex(log);
      if (!txHash || logIndex == null) {
        logger.warn?.('[listener] Skipping factory log with missing txHash or logIndex');
        continue;
      }

      const parsed = factoryInterface.parseLog(log);
      let vaultAddress;

      await prisma.$transaction(async (tx) => {
        if (await isProcessed(tx, txHash, logIndex)) {
          return;
        }

        const result = await handleFactoryCreated({
          prisma: tx,
          args: parsed.args,
          contractAddress: normalizeAddress(log.address),
          logger
        });
        vaultAddress = result?.vaultAddress;

        await markProcessed(tx, {
          txHash,
          logIndex,
          contractAddress: normalizeAddress(log.address),
          eventName: parsed.name,
          escrowId: parsed.args.escrowId,
          blockNumber: Number(log.blockNumber)
        });
      });

      if (vaultAddress) knownVaults.add(vaultAddress);
    }
  }

  async function processVaultLogs(fromBlock, toBlock) {
    if (knownVaults.size === 0) return;

    const logs = await provider.getLogs({
      address: [...knownVaults],
      fromBlock,
      toBlock
    });

    for (const log of logs) {
      let parsed;
      try {
        parsed = vaultInterface.parseLog(log);
      } catch {
        continue;
      }

      const txHash = getTxHash(log);
      const logIndex = getLogIndex(log);
      if (!txHash || logIndex == null) {
        logger.warn?.('[listener] Skipping vault log with missing txHash or logIndex');
        continue;
      }

      await prisma.$transaction(async (tx) => {
        if (await isProcessed(tx, txHash, logIndex)) {
          return;
        }

        await handleVaultEvent({
          prisma: tx,
          parsedLog: parsed,
          contractAddress: normalizeAddress(log.address)
        });

        await markProcessed(tx, {
          txHash,
          logIndex,
          contractAddress: normalizeAddress(log.address),
          eventName: parsed.name,
          escrowId: parsed.args.escrowId,
          blockNumber: Number(log.blockNumber)
        });
      });
    }
  }

  async function bootstrapKnownVaults() {
    const escrows = await prisma.escrow.findMany({
      where: { contractAddress: { not: null } },
      select: { contractAddress: true }
    });

    for (const escrow of escrows) {
      if (escrow.contractAddress) knownVaults.add(normalizeAddress(escrow.contractAddress));
    }
  }

  async function loop() {
    await bootstrapKnownVaults();
    let syncState = await ensureSyncState(prisma, startBlock);

    while (running) {
      try {
        const latestBlock = await provider.getBlockNumber();
        const safeBlock = Math.max(0, latestBlock - confirmations);

        if (safeBlock <= syncState.lastProcessedBlock) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }

        const fromBlock = syncState.lastProcessedBlock + 1;
        const toBlock = Math.min(fromBlock + blockBatchSize - 1, safeBlock);

        await processFactoryLogs(fromBlock, toBlock);
        await processVaultLogs(fromBlock, toBlock);

        syncState = await prisma.eventSyncState.update({
          where: { key: SYNC_STATE_KEY },
          data: { lastProcessedBlock: toBlock }
        });

        logger.info?.(`[listener] Synced blocks ${fromBlock}-${toBlock}, vaults=${knownVaults.size}`);
      } catch (error) {
        logger.error?.('[listener] Sync error:', error.message);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  loopPromise = loop();

  return {
    async stop() {
      running = false;
      await loopPromise;
    }
  };
}
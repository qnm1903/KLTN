import { ethers } from 'ethers';
import { mediatorPoolAbi } from '../abi.js';
import { emitToRoom } from '../lib/socket-emitter.js';

const APPEAL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function normalizeAddress(value) {
  if (!value) return null;
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function extractEventMeta(event) {
  const log = event?.log ?? event;
  return {
    txHash: log?.transactionHash ?? log?.txHash ?? null,
    logIndex: Number(log?.index ?? log?.logIndex ?? -1),
    blockNumber: Number(log?.blockNumber ?? 0)
  };
}

function isDuplicateError(error) {
  return error?.code === 'P2002';
}

export async function handleReputationUpdated({ prisma, mediator, oldScore, newScore, event, logger = console }) {
  const mediatorAddress = normalizeAddress(mediator);
  const meta = extractEventMeta(event);

  if (!mediatorAddress || !meta.txHash || meta.logIndex < 0) {
    logger.warn?.('[mediator-reputation] Skipping ReputationUpdated with incomplete metadata');
    return null;
  }

  const payload = {
    mediatorAddress,
    oldScore: Number(oldScore),
    newScore: Number(newScore),
    delta: Number(newScore) - Number(oldScore),
    txHash: meta.txHash,
    logIndex: meta.logIndex,
    blockNumber: meta.blockNumber
  };

  try {
    const row = await prisma.mediatorReputationHistory.create({ data: payload });

    emitToRoom(`mediator:${mediatorAddress}`, 'mediator:reputation-updated', {
      mediatorAddress,
      oldScore: payload.oldScore,
      newScore: payload.newScore,
      delta: payload.delta,
      txHash: payload.txHash,
      blockNumber: payload.blockNumber,
      createdAt: row.createdAt
    });

    return row;
  } catch (error) {
    if (isDuplicateError(error)) return null;
    throw error;
  }
}

export async function handleMediatorSlashed({ prisma, mediator, amount, event, logger = console }) {
  const mediatorAddress = normalizeAddress(mediator);
  const meta = extractEventMeta(event);

  if (!mediatorAddress || !meta.txHash || meta.logIndex < 0) {
    logger.warn?.('[mediator-reputation] Skipping MediatorSlashed with incomplete metadata');
    return null;
  }

  const appealDeadlineAt = new Date(Date.now() + APPEAL_WINDOW_MS);
  const payload = {
    mediatorAddress,
    amount: String(amount),
    status: 'PENDING',
    appealDeadlineAt,
    txHash: meta.txHash,
    logIndex: meta.logIndex,
    blockNumber: meta.blockNumber
  };

  try {
    const row = await prisma.mediatorSlash.create({ data: payload });

    emitToRoom(`mediator:${mediatorAddress}`, 'mediator:slashed', {
      id: row.id,
      mediatorAddress,
      amount: payload.amount,
      status: payload.status,
      appealDeadlineAt,
      txHash: payload.txHash,
      blockNumber: payload.blockNumber,
      createdAt: row.createdAt
    });

    return row;
  } catch (error) {
    if (isDuplicateError(error)) return null;
    throw error;
  }
}

export function startMediatorReputationListener({ prisma, logger = console, config = {} }) {
  const rpcUrl = config.rpcUrl ?? process.env.WS_RPC_URL ?? process.env.RPC_URL;
  const mediatorPoolAddress = config.mediatorPoolAddress ?? process.env.MEDIATOR_POOL_CONTRACT;

  if (!rpcUrl || !mediatorPoolAddress) {
    logger.warn?.('[mediator-reputation] Missing RPC_URL/WS_RPC_URL or MEDIATOR_POOL_CONTRACT, skipping listener');
    return { stop: async () => {} };
  }

  const isWsRpc = /^wss?:\/\//i.test(rpcUrl);
  const provider = isWsRpc
    ? new ethers.WebSocketProvider(rpcUrl)
    : new ethers.JsonRpcProvider(rpcUrl);

  if (isWsRpc && provider.websocket) {
    provider.websocket.onerror = (error) => {
      logger.error?.('[mediator-reputation] WebSocket provider error:', error?.message ?? error);
    };
  }

  const contract = new ethers.Contract(mediatorPoolAddress, mediatorPoolAbi, provider);

  contract.on('ReputationUpdated', async (mediator, oldScore, newScore, event) => {
    try {
      await handleReputationUpdated({ prisma, mediator, oldScore, newScore, event, logger });
    } catch (error) {
      logger.error?.('[mediator-reputation] ReputationUpdated handler failed:', error?.message ?? error);
    }
  });

  contract.on('MediatorSlashed', async (mediator, amount, event) => {
    try {
      await handleMediatorSlashed({ prisma, mediator, amount, event, logger });
    } catch (error) {
      logger.error?.('[mediator-reputation] MediatorSlashed handler failed:', error?.message ?? error);
    }
  });

  logger.info?.('[mediator-reputation] Listener started');

  return {
    async stop() {
      contract.removeAllListeners();
      provider.removeAllListeners();
      if (typeof provider.destroy === 'function') {
        await provider.destroy();
      }
      logger.info?.('[mediator-reputation] Listener stopped');
    }
  };
}

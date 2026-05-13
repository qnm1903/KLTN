import { ethers } from 'ethers';
import prisma from '../lib/prisma.js';
import { mediatorPoolAbi } from '../abi.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class ServiceError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'ServiceError';
    this.statusCode = statusCode;
  }
}

export function normalizeAndValidateAddress(address) {
  if (!address || !ethers.isAddress(address)) {
    throw new ServiceError('Invalid mediator address', 400);
  }
  return ethers.getAddress(address).toLowerCase();
}

export function parsePagination(limit, offset, defaultLimit = DEFAULT_LIMIT) {
  const parsedLimit = limit == null ? defaultLimit : Number(limit);
  const parsedOffset = offset == null ? 0 : Number(offset);

  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
    throw new ServiceError('limit must be an integer in [1..100]', 400);
  }

  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
    throw new ServiceError('offset must be an integer >= 0', 400);
  }

  return { limit: parsedLimit, offset: parsedOffset };
}

export function computeAppealState(status, appealDeadlineAt, now = new Date()) {
  if (status === 'CANCELLED' || status === 'FINALIZED') return status;
  if (status !== 'PENDING') return status;
  return now < new Date(appealDeadlineAt) ? 'OPEN' : 'EXPIRED';
}

function getMediatorPoolContract() {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.MEDIATOR_POOL_CONTRACT;

  if (!rpcUrl || !contractAddress) {
    throw new ServiceError('RPC_URL and MEDIATOR_POOL_CONTRACT are required', 500);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Contract(contractAddress, mediatorPoolAbi, provider);
}

export async function getReputationOnChain(address) {
  const normalizedAddress = normalizeAndValidateAddress(address);
  const mediatorPool = getMediatorPoolContract();
  const mediator = await mediatorPool.mediators(normalizedAddress);

  return {
    address: normalizedAddress,
    currentScore: Number(mediator.reputationScore ?? 0),
    timeoutCount: Number(mediator.timeoutCount ?? 0),
    totalVotes: Number(mediator.totalVotes ?? 0),
    successfulVotes: Number(mediator.successfulVotes ?? 0),
    isActive: Boolean(mediator.isActive)
  };
}

export async function getHistory(address, limit, offset) {
  const normalizedAddress = normalizeAndValidateAddress(address);
  const pagination = parsePagination(limit, offset);

  const where = { mediatorAddress: normalizedAddress };

  const [items, total] = await Promise.all([
    prisma.mediatorReputationHistory.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { logIndex: 'desc' }],
      take: pagination.limit,
      skip: pagination.offset
    }),
    prisma.mediatorReputationHistory.count({ where })
  ]);

  return { items, total, ...pagination };
}

export async function getSlashes(address, options = {}) {
  const normalizedAddress = normalizeAndValidateAddress(address);
  const pagination = parsePagination(options.limit, options.offset);

  if (options.status && !['PENDING', 'CANCELLED', 'FINALIZED'].includes(options.status)) {
    throw new ServiceError('status must be one of PENDING | CANCELLED | FINALIZED', 400);
  }

  const where = {
    mediatorAddress: normalizedAddress,
    ...(options.status ? { status: options.status } : {})
  };

  const [rows, total] = await Promise.all([
    prisma.mediatorSlash.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { logIndex: 'desc' }],
      take: pagination.limit,
      skip: pagination.offset
    }),
    prisma.mediatorSlash.count({ where })
  ]);

  const now = new Date();
  const items = rows.map((row) => ({
    ...row,
    appealState: computeAppealState(row.status, row.appealDeadlineAt, now)
  }));

  return { items, total, ...pagination };
}

export async function getMediatorReputationSnapshot(address, options = {}) {
  const normalizedAddress = normalizeAndValidateAddress(address);
  const historyLimit = Number(options.historyLimit ?? 10);
  const slashLimit = Number(options.slashLimit ?? 10);

  const chain = await getReputationOnChain(normalizedAddress);
  const [historyData, slashData] = await Promise.all([
    getHistory(normalizedAddress, historyLimit, 0),
    getSlashes(normalizedAddress, { limit: slashLimit, offset: 0 })
  ]);

  const pending = slashData.items.filter((row) => row.appealState === 'OPEN');
  const nearestDeadline = pending.length
    ? pending.reduce((min, row) => (new Date(row.appealDeadlineAt) < new Date(min) ? row.appealDeadlineAt : min), pending[0].appealDeadlineAt)
    : null;

  return {
    address: normalizedAddress,
    currentScore: chain.currentScore,
    summary: {
      timeoutCount: chain.timeoutCount,
      totalVotes: chain.totalVotes,
      successfulVotes: chain.successfulVotes,
      pendingAppeals: pending.length,
      nearestAppealDeadlineAt: nearestDeadline
    },
    history: historyData.items,
    slashes: slashData.items
  };
}

export async function resolveSlashAppeal({ address, slashId, action, resolvedBy, resolutionNote }) {
  const normalizedAddress = normalizeAndValidateAddress(address);

  if (!slashId || typeof slashId !== 'string') {
    throw new ServiceError('Invalid slashId', 400);
  }

  const targetStatus = action === 'accept' ? 'CANCELLED' : action === 'reject' ? 'FINALIZED' : null;
  if (!targetStatus) {
    throw new ServiceError('Invalid action', 400);
  }

  const slash = await prisma.mediatorSlash.findUnique({ where: { id: slashId } });
  if (!slash || slash.mediatorAddress !== normalizedAddress) {
    throw new ServiceError('Slash record not found', 404);
  }

  if (slash.status !== 'PENDING') {
    throw new ServiceError('Slash record already resolved', 409);
  }

  if (new Date() >= new Date(slash.appealDeadlineAt)) {
    throw new ServiceError('Appeal window expired', 409);
  }

  return prisma.mediatorSlash.update({
    where: { id: slashId },
    data: {
      status: targetStatus,
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      resolutionNote: resolutionNote ?? null
    }
  });
}

// In-memory map: escrowId -> { pubKeys, pkAgg, nonces, zShares, signingRoles, signingAction, round2Context, completedActions, createdAt, status, parties }
import {
	SESSION_TTL_MS,
	SIGNING_TTL_MS,
	getPubKeyCollectionSummary,
	syncPubKeyCollectionState,
	isPubKeySetComplete
} from '../crypto/dkg.js';

export const sessions = new Map();

let prismaClientPromise = null;
let persistenceDisabled = false;

function isMissingTableError(error) {
	const message = String(error?.message || '').toLowerCase();
	return message.includes('no such table') || message.includes('does not exist') || error?.code === 'P2021';
}

async function getPrismaClient() {
	if (persistenceDisabled) return null;
	if (!prismaClientPromise) {
		prismaClientPromise = import('../lib/prisma.js').then((mod) => mod.default);
	}
	return prismaClientPromise;
}

async function withPersistence(operation) {
	const prisma = await getPrismaClient();
	if (!prisma?.signingSession) return null;

	try {
		return await operation(prisma);
	} catch (error) {
		if (isMissingTableError(error)) {
			persistenceDisabled = true;
			console.warn('[session-store] SigningSession table is unavailable, falling back to in-memory mode.');
			return null;
		}
		throw error;
	}
}

function normalizeSession(session, fallbackCreatedAt = Date.now()) {
	if (!session || typeof session !== 'object') return null;

	const createdAt = Number(session.createdAt || fallbackCreatedAt || Date.now());
	const normalized = {
		...session,
		createdAt,
		pubKeys: session.pubKeys && typeof session.pubKeys === 'object' ? session.pubKeys : {},
		nonces: session.nonces && typeof session.nonces === 'object' ? session.nonces : {},
		zShares: session.zShares && typeof session.zShares === 'object' ? session.zShares : {},
		completedActions: Array.isArray(session.completedActions) ? session.completedActions : [],
		signingRoles: Array.isArray(session.signingRoles) ? session.signingRoles : session.signingRoles || null,
		signingAction: session.signingAction || null,
		pubKeyCollectionState: session.pubKeyCollectionState || session.pubkeyCollectionState || null,
		pubKeyCollectionDueAt: Number(session.pubKeyCollectionDueAt || (createdAt + SESSION_TTL_MS)),
		pubKeyAggregationCompletedAt: session.pubKeyAggregationCompletedAt || session.pubkeyAggregationCompletedAt || null,
		precomputedPkAgg: session.precomputedPkAgg || null,
		round2Context: session.round2Context || null,
		status: session.status || 'INITIALIZED'
	};

	const summary = syncPubKeyCollectionState(normalized);
	if (summary.complete && !normalized.pubKeyAggregationCompletedAt) {
		normalized.pubKeyAggregationCompletedAt = createdAt;
	}

	return normalized;
}

function computeExpiresAt(createdAt) {
	return new Date(Number(createdAt) + SESSION_TTL_MS);
}

function isSessionExpired(session, nowMs = Date.now()) {
	return nowMs - Number(session.createdAt || 0) > SESSION_TTL_MS;
}

export function isSigningExpired(session, nowMs = Date.now()) {
	if (!session.signingStartedAt) return false;
	return nowMs - Number(session.signingStartedAt) > SIGNING_TTL_MS;
}

export async function saveSession(escrowId, session) {
	const normalized = normalizeSession(session);
	if (!normalized) {
		throw new Error('Invalid session payload');
	}

	sessions.set(escrowId, normalized);

	await withPersistence((prisma) => prisma.signingSession.upsert({
		where: { escrowId },
		update: {
			payload: normalized,
			status: 'ACTIVE',
			expiresAt: computeExpiresAt(normalized.createdAt)
		},
		create: {
			escrowId,
			payload: normalized,
			status: 'ACTIVE',
			expiresAt: computeExpiresAt(normalized.createdAt)
		}
	}));

	return normalized;
}

export async function getSession(escrowId, options = {}) {
	const { allowExpired = false } = options;

	const cached = sessions.get(escrowId);
	if (cached) {
		if (!allowExpired && isSessionExpired(cached)) {
			await deleteSession(escrowId, { markExpired: true });
			return null;
		}
		return cached;
	}

	const persisted = await withPersistence((prisma) => prisma.signingSession.findUnique({
		where: { escrowId },
		select: {
			payload: true,
			expiresAt: true,
			createdAt: true,
			status: true
		}
	}));

	if (!persisted) return null;

	const restored = normalizeSession(persisted.payload, persisted.createdAt?.getTime());
	if (!restored) {
		await deleteSession(escrowId, { markExpired: true });
		return null;
	}

	const dbExpired = persisted.status === 'EXPIRED' || (persisted.expiresAt instanceof Date && persisted.expiresAt.getTime() <= Date.now());
	if (!allowExpired && dbExpired) {
		await deleteSession(escrowId, { markExpired: true });
		return null;
	}

	sessions.set(escrowId, restored);
	return restored;
}

export async function hasSession(escrowId) {
	return Boolean(await getSession(escrowId));
}

export async function deleteSession(escrowId, options = {}) {
	const { markExpired = false } = options;
	sessions.delete(escrowId);

	if (markExpired) {
		await withPersistence((prisma) => prisma.signingSession.updateMany({
			where: { escrowId },
			data: {
				status: 'EXPIRED',
				expiresAt: new Date()
			}
		}));
		return;
	}

	await withPersistence((prisma) => prisma.signingSession.deleteMany({
		where: { escrowId }
	}));
}

export async function clearSessions() {
	sessions.clear();
	await withPersistence((prisma) => prisma.signingSession.deleteMany());
}

export function getPubKeyCollectionStatus(session, now = Date.now()) {
	return getPubKeyCollectionSummary(session, now);
}

export function isPubKeyCollectionExpired(session, now = Date.now()) {
	const summary = getPubKeyCollectionSummary(session, now);
	return summary.expired;
}

export function isPubKeyCollectionReady(session) {
	return isPubKeySetComplete(session);
}
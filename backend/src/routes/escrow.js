import express from 'express';
import { deleteSession, getSession, getPubKeyCollectionStatus, hasSession, saveSession } from '../store/session.js';
import {
  aggregateWhenReady,
  aggregatePubKeysForRoles,
  PARTICIPANT_ROLES,
  getActionSigners,
  getPubKeyCollectionSummary,
  getPkAggForRoles,
  initDKG,
  initIncrementalDKG,
  SESSION_TTL_MS
} from '../crypto/dkg.js';
import { aggregateNonces, computeChallenge, aggregateZShares } from '../crypto/schnorr.js';
import { ethers } from 'ethers';
import { createRouteRateLimiter, getRateLimitConfig } from '../middleware/rate-limit.js';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const factoryAbi = [
  'function createEscrow(address seller, address[5] calldata mediators, uint256[2] calldata pkAggCoords, uint256 amount, uint256 confirmDays, uint256 timeoutDays) external returns (address)'
];

const router = express.Router();
const { escrowInitMax, escrowSignMax, escrowPubKeySubmitMax } = getRateLimitConfig();

const escrowInitRateLimiter = createRouteRateLimiter({
  max: escrowInitMax,
  message: 'Too many escrow init requests. Please try again later.'
});

const escrowSignRateLimiter = createRouteRateLimiter({
  max: escrowSignMax,
  message: 'Too many escrow sign requests. Please try again later.'
});

const escrowPubKeySubmitRateLimiter = createRouteRateLimiter({
  max: escrowPubKeySubmitMax,
  message: 'Too many pubkey submission requests. Please try again later.'
});

const VALID_ROLES = [...PARTICIPANT_ROLES];
const VALID_ACTIONS = ['release', 'refund', 'timeout'];
const MEDIATOR_COMMITTEE_SIZE = 5;

let pubKeyPersistenceDisabled = false;

function getActionSignerRoles(action) {
  return getActionSigners(action);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function checkSession(escrowId, res) {
  const session = await getSession(escrowId, { allowExpired: true });
  if (!session) { res.status(404).json({ error: 'Escrow session not found' }); return null; }
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    await deleteSession(escrowId, { markExpired: true });
    res.status(410).json({ error: 'Session expired' });
    return null;
  }
  return session;
}

function buildMsgHash(escrowId, action, signerBitmap, contractAddress, chainId) {
  const id = escrowId.startsWith('0x') ? escrowId : ethers.id(escrowId);
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'bytes32', 'string', 'uint8'],
    [BigInt(chainId).toString(), contractAddress, id, action, signerBitmap]
  );
}

function normalizePubKey(pubKeyHex) {
  if (typeof pubKeyHex !== 'string') {
    throw new Error('Invalid public key format');
  }
  const clean = pubKeyHex.replace('0x', '');
  if (clean.startsWith('04')) {
    return clean;
  }
  if (clean.startsWith('02') || clean.startsWith('03')) {
    throw new Error('Compressed public keys are not supported. Please provide an uncompressed key.');
  }
  if (clean.length === 128) {
    return '04' + clean;
  }
  throw new Error('Invalid public key format');
}

function isMissingTableError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('no such table') || message.includes('does not exist') || error?.code === 'P2021';
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function toIsoTimestamp(timestampMs) {
  return Number.isFinite(Number(timestampMs)) ? new Date(Number(timestampMs)).toISOString() : null;
}

function toCollectionPayload(summary) {
  return {
    state: summary.state,
    required: summary.required,
    received: summary.received,
    missingRoles: summary.missingRoles,
    dueAt: toIsoTimestamp(summary.dueAt)
  };
}

function getRoleAddress(participants, role) {
  if (!participants || typeof participants !== 'object') return null;
  if (role === 'buyer') return normalizeAddress(participants.buyer);
  if (role === 'seller') return normalizeAddress(participants.seller);
  if (!role.startsWith('mediator')) return null;

  const slot = Number(role.replace('mediator', ''));
  if (!Number.isInteger(slot) || slot < 1 || slot > MEDIATOR_COMMITTEE_SIZE) {
    return null;
  }

  const mediators = Array.isArray(participants.mediators) ? participants.mediators : [];
  return normalizeAddress(mediators[slot - 1]);
}

function buildParticipantsSnapshot(escrow) {
  const mediatorBySlot = new Array(MEDIATOR_COMMITTEE_SIZE).fill(null);

  for (const row of escrow.escrowMediators || []) {
    if (!row?.slot || row.slot < 1 || row.slot > MEDIATOR_COMMITTEE_SIZE) continue;
    mediatorBySlot[row.slot - 1] = normalizeAddress(row?.mediator?.walletAddress);
  }

  if (!normalizeAddress(escrow?.buyer?.walletAddress) || !normalizeAddress(escrow?.seller?.walletAddress)) {
    return null;
  }
  if (mediatorBySlot.some((address) => !address)) {
    return null;
  }

  return {
    buyer: normalizeAddress(escrow.buyer.walletAddress),
    seller: normalizeAddress(escrow.seller.walletAddress),
    mediators: mediatorBySlot
  };
}

async function resolveEscrowParticipants(escrowId) {
  const escrow = await prisma.escrow.findUnique({
    where: { id: escrowId },
    select: {
      id: true,
      buyer: { select: { walletAddress: true } },
      seller: { select: { walletAddress: true } },
      escrowMediators: {
        select: {
          slot: true,
          mediator: { select: { walletAddress: true } }
        },
        orderBy: { slot: 'asc' }
      }
    }
  });

  if (!escrow) {
    return null;
  }

  const participants = buildParticipantsSnapshot(escrow);
  if (!participants) {
    throw new Error('Escrow participants are incomplete. Expected buyer, seller, and 5 mediators.');
  }

  return participants;
}

async function savePubKeySubmission(escrowId, role, pubKey) {
  if (pubKeyPersistenceDisabled || !prisma?.pubKeySubmission?.create) {
    return { status: 'skipped' };
  }

  try {
    // Dùng create-first để tận dụng unique(escrowId, role):
    // - insert thành công => lần submit đầu tiên của role
    // - dính P2002 => đã có bản ghi, so sánh để phân biệt idempotent vs conflict
    // Không dùng upsert vì upsert có thể overwrite pubKey cũ trong race condition.
    await prisma.pubKeySubmission.create({
      data: {
        escrowId,
        role,
        pubKey
      }
    });
    return { status: 'created' };
  } catch (error) {
    if (isMissingTableError(error)) {
      pubKeyPersistenceDisabled = true;
      console.warn('[escrow-route] PubKeySubmission table is unavailable, falling back to session payload only.');
      return { status: 'skipped' };
    }

    if (error?.code === 'P2002' && prisma?.pubKeySubmission?.findUnique) {
      const existing = await prisma.pubKeySubmission.findUnique({
        where: {
          escrowId_role: {
            escrowId,
            role
          }
        },
        select: { pubKey: true }
      });

      if (existing?.pubKey) {
        const existingPubKey = '0x' + normalizePubKey(existing.pubKey);
        const incomingPubKey = '0x' + normalizePubKey(pubKey);
        if (existingPubKey.toLowerCase() === incomingPubKey.toLowerCase()) {
          return { status: 'idempotent' };
        }
      }

      return { status: 'conflict' };
    }

    throw error;
  }
}

async function clearPubKeySubmissions(escrowId) {
  if (pubKeyPersistenceDisabled || !prisma?.pubKeySubmission?.deleteMany) return;

  try {
    await prisma.pubKeySubmission.deleteMany({ where: { escrowId } });
  } catch (error) {
    if (isMissingTableError(error)) {
      pubKeyPersistenceDisabled = true;
      console.warn('[escrow-route] PubKeySubmission table is unavailable, skipping cleanup.');
      return;
    }
    throw error;
  }
}

function rolesMatchAction(roles, action) {
  const expected = [...getActionSignerRoles(action)].sort().join('+');
  const actual = [...new Set(roles)].sort().join('+');
  return expected === actual;
}

// ─── Phase 1: DKG ─────────────────────────────────────────────────────────────

/**
 * POST /api/escrow/init
 * Frontend gửi 3 public keys (mỗi bên tự sinh s_i ở thiết bị của mình).
 * Backend chỉ tổng hợp PKagg pairs — không sinh hoặc biết private key nào.
 * Trả về 3 PKagg pairs để frontend đưa vào lúc tạo EscrowVault.
 */
router.post('/init', escrowInitRateLimiter, async (req, res) => {
  try {
    const {
      escrowId,
      chainId,
      contractAddress,
      buyerAddr,
      sellerAddr,
      mediatorAddrs,
      buyerPubKey,
      sellerPubKey,
      mediatorPubKeys
    } = req.body;

    if (!escrowId || !chainId || !contractAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ethers.isAddress(contractAddress)) {
      return res.status(400).json({ error: 'Invalid contractAddress' });
    }

    let normalizedChainId;
    try {
      normalizedChainId = BigInt(chainId).toString();
    } catch {
      return res.status(400).json({ error: 'Invalid chainId' });
    }

    const normalizedContractAddress = ethers.getAddress(contractAddress);

    if (await hasSession(escrowId)) {
      return res.status(409).json({ error: 'Session already exists for this escrowId' });
    }

    const batchPayloadProvided = Boolean(
      buyerAddr || sellerAddr || mediatorAddrs || buyerPubKey || sellerPubKey || mediatorPubKeys
    );

    if (batchPayloadProvided) {
      if (!buyerAddr || !sellerAddr || !Array.isArray(mediatorAddrs) || mediatorAddrs.length !== 5 ||
          !buyerPubKey || !sellerPubKey || !Array.isArray(mediatorPubKeys) || mediatorPubKeys.length !== 5) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const derivedBuyer = ethers.computeAddress('0x' + normalizePubKey(buyerPubKey));
      const derivedSeller = ethers.computeAddress('0x' + normalizePubKey(sellerPubKey));
      const derivedMediatorAddrs = mediatorPubKeys.map((pubKey) => ethers.computeAddress('0x' + normalizePubKey(pubKey)));

      if (derivedBuyer.toLowerCase() !== buyerAddr.toLowerCase()) {
        return res.status(400).json({ error: 'buyerPubKey does not match buyerAddr' });
      }
      if (derivedSeller.toLowerCase() !== sellerAddr.toLowerCase()) {
        return res.status(400).json({ error: 'sellerPubKey does not match sellerAddr' });
      }
      for (let index = 0; index < mediatorAddrs.length; index++) {
        if (derivedMediatorAddrs[index].toLowerCase() !== mediatorAddrs[index].toLowerCase()) {
          return res.status(400).json({ error: `mediatorPubKeys[${index}] does not match mediatorAddrs[${index}]` });
        }
      }

      const { session } = initDKG(escrowId, {
        buyerPubKey,
        sellerPubKey,
        mediatorPubKeys,
        participants: {
          buyer: buyerAddr.toLowerCase(),
          seller: sellerAddr.toLowerCase(),
          mediators: mediatorAddrs.map((address) => address.toLowerCase())
        },
        contractAddress: normalizedContractAddress,
        chainId: normalizedChainId
      });

      session.parties = {
        buyer: buyerAddr.toLowerCase(),
        seller: sellerAddr.toLowerCase(),
        mediators: mediatorAddrs.map((address) => address.toLowerCase())
      };
      await saveSession(escrowId, session);

      const collection = getPubKeyCollectionSummary(session);
      return res.json({
        ok: true,
        contractAddress: normalizedContractAddress,
        chainId: normalizedChainId,
        collection: toCollectionPayload(collection)
      });
    }

    const participants = await resolveEscrowParticipants(escrowId);
    if (!participants) {
      return res.status(404).json({ error: 'Escrow not found' });
    }

    await clearPubKeySubmissions(escrowId);

    const { session } = initIncrementalDKG(escrowId, {
      participants,
      contractAddress: normalizedContractAddress,
      chainId: normalizedChainId,
      dueAtMs: Date.now() + SESSION_TTL_MS
    });

    session.parties = participants;
    await saveSession(escrowId, session);

    const collection = getPubKeyCollectionSummary(session);
    return res.json({
      ok: true,
      contractAddress: normalizedContractAddress,
      chainId: normalizedChainId,
      collection: toCollectionPayload(collection)
    });
  } catch (error) {
    console.error('Error in /init:', error.message);
    if (/public key/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (/participants are incomplete/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

router.post('/pubkey/submit', authMiddleware, escrowPubKeySubmitRateLimiter, async (req, res) => {
  try {
    const { escrowId, role, pubKey } = req.body;

    if (!escrowId || !role || !pubKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof escrowId !== 'string' || typeof role !== 'string' || typeof pubKey !== 'string') {
      return res.status(400).json({ error: 'Invalid payload types' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }

    const session = await checkSession(escrowId, res);
    if (!session) return;

    const io = req.app.get('io');
    const summaryBefore = getPubKeyCollectionSummary(session);
    if (summaryBefore.expired) {
      const wasExpired = session.pubKeyCollectionState === 'EXPIRED' || session.pubkeyCollectionState === 'EXPIRED';
      session.pubKeyCollectionState = 'EXPIRED';
      await saveSession(escrowId, session);

      if (io && !wasExpired) {
        io.to(escrowId).emit('pubkey_collection_expired', {
          escrowId,
          dueAt: toIsoTimestamp(summaryBefore.dueAt),
          expiredAt: new Date().toISOString()
        });
      }

      return res.status(410).json({
        error: 'Pubkey collection expired',
        collection: toCollectionPayload(getPubKeyCollectionSummary(session))
      });
    }

    const normalizedPubKey = '0x' + normalizePubKey(pubKey);
    session.pubKeys = session.pubKeys && typeof session.pubKeys === 'object' ? session.pubKeys : {};
    const existingPubKey = session.pubKeys[role];
    if (existingPubKey) {
      const normalizedExistingPubKey = '0x' + normalizePubKey(existingPubKey);
      if (normalizedExistingPubKey.toLowerCase() === normalizedPubKey.toLowerCase()) {
        const collection = getPubKeyCollectionSummary(session);
        return res.json({
          ok: true,
          state: collection.state,
          received: collection.received,
          required: collection.required,
          isIdempotent: true,
          collection: toCollectionPayload(collection)
        });
      }

      if (io) {
        io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'CONFLICT' });
      }
      return res.status(409).json({ error: `Role '${role}' already submitted a different pubKey` });
    }

    const participants = session.participants || session.parties;
    const expectedAddress = getRoleAddress(participants, role);
    if (!expectedAddress) {
      if (io) {
        io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'ROLE_NOT_ALLOWED' });
      }
      return res.status(403).json({ error: `Role '${role}' is not allowed in this escrow` });
    }

    const requesterAddress = normalizeAddress(req.user?.walletAddress);
    if (requesterAddress !== expectedAddress) {
      if (io) {
        io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'AUTH_ROLE_MISMATCH' });
      }
      return res.status(403).json({ error: `Authenticated wallet is not allowed to submit pubKey for role '${role}'` });
    }

    const derivedAddress = ethers.computeAddress(normalizedPubKey).toLowerCase();

    if (derivedAddress !== expectedAddress) {
      if (io) {
        io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'PUBKEY_ADDR_MISMATCH' });
      }
      return res.status(400).json({ error: `${role} pubKey does not match expected address` });
    }

    const persistenceResult = await savePubKeySubmission(escrowId, role, normalizedPubKey);
    if (persistenceResult.status === 'conflict') {
      if (io) {
        io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'CONFLICT' });
      }
      return res.status(409).json({ error: `Role '${role}' already submitted a different pubKey` });
    }
    if (persistenceResult.status === 'idempotent') {
      session.pubKeys[role] = normalizedPubKey;
      await saveSession(escrowId, session);

      const collection = getPubKeyCollectionSummary(session);
      return res.json({
        ok: true,
        state: collection.state,
        received: collection.received,
        required: collection.required,
        isIdempotent: true,
        collection: toCollectionPayload(collection)
      });
    }

    session.pubKeys[role] = normalizedPubKey;
    let summary = getPubKeyCollectionSummary(session);
    session.pubKeyCollectionState = summary.complete ? 'COMPLETE' : 'PARTIAL';

    if (summary.complete && !session.pubKeyAggregationCompletedAt) {
      session.precomputedPkAgg = aggregateWhenReady(session);
      session.pubKeyAggregationCompletedAt = Date.now();
    }

    await saveSession(escrowId, session);

    summary = getPubKeyCollectionSummary(session);

    if (io) {
      io.to(escrowId).emit('pubkey_received', {
        escrowId,
        role,
        received: summary.received,
        required: summary.required,
        missingRoles: summary.missingRoles
      });

      if (summary.complete) {
        io.to(escrowId).emit('pubkey_collection_complete', {
          escrowId,
          received: summary.received,
          required: summary.required,
          completedAt: toIsoTimestamp(session.pubKeyAggregationCompletedAt || Date.now())
        });
      }
    }

    return res.json({
      ok: true,
      state: summary.state,
      received: summary.received,
      required: summary.required,
      isIdempotent: false,
      collection: toCollectionPayload(summary)
    });
  } catch (error) {
    console.error('Error in /pubkey/submit:', error.message);
    if (/public key|invalid role|does not match expected address/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

// ─── Phase 2: Threshold Signing — Round 1 (Nonce submission) ──────────────────

/**
 * POST /api/escrow/nonce
 * Mỗi bên gửi nonce point R_i = k_i * G (không gửi k_i).
 * Khi đủ 2 bên: backend tổng hợp R, tính challenge e, broadcast qua WebSocket.
 *
 * Body: { escrowId, role, action, R_x, R_y }
 */
router.post('/nonce', authMiddleware, async (req, res) => {
  try {
    const { escrowId, role, action, signerBitmap, R_x, R_y } = req.body;

    if (!escrowId || !role || !action || signerBitmap === undefined || !R_x || !R_y) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Allowed: ${VALID_ACTIONS.join(', ')}` });
    }

    const session = await checkSession(escrowId, res);
    if (!session) return;

    const participants = session.participants || session.parties;
    const expectedAddress = getRoleAddress(participants, role);
    if (!expectedAddress) {
      return res.status(403).json({ error: `Role '${role}' is not allowed in this escrow` });
    }

    const requesterAddress = normalizeAddress(req.user?.walletAddress);
    if (requesterAddress !== expectedAddress) {
      return res.status(403).json({ error: `Authenticated wallet is not allowed to submit nonce for role '${role}'` });
    }

    const collection = getPubKeyCollectionSummary(session);
    if (collection.expired) {
      session.pubKeyCollectionState = 'EXPIRED';
      await saveSession(escrowId, session);
      return res.status(410).json({
        error: 'Pubkey collection expired',
        collection: toCollectionPayload(collection)
      });
    }
    if (!collection.complete) {
      return res.status(409).json({
        error: 'Pubkey collection is incomplete. Submit all participant pubkeys first.',
        collection: toCollectionPayload(collection)
      });
    }

    if (session.completedActions.includes(action)) {
      return res.status(409).json({ error: `Action '${action}' already signed` });
    }

    const actionRoles = getActionSignerRoles(action);
    if (!actionRoles.includes(role)) {
      return res.status(403).json({ error: `Role '${role}' is not allowed for action '${action}'` });
    }

    const bitmap = Number(signerBitmap);
    if (!Number.isInteger(bitmap) || bitmap < 0 || bitmap > 0x7f) {
      return res.status(400).json({ error: 'Invalid signerBitmap' });
    }

    // Khi round 1 bắt đầu, lock action và xác định 2 bên tham gia
    if (!session.signingAction) {
      session.signingAction = action;
      session.nonces = {};
      session.zShares = {};
      session.signingBitmap = bitmap;
    } else if (session.signingAction !== action) {
      return res.status(409).json({ error: 'Different action already in progress' });
    } else if (session.signingBitmap !== bitmap) {
      return res.status(409).json({ error: 'Different signerBitmap already in progress' });
    }

    // Verify role này có trong session
    if (!session.pubKeys[role]) {
      return res.status(403).json({ error: `Role '${role}' not found in this escrow` });
    }

    const nonceCountBefore = Object.keys(session.nonces).length;
    if (!session.nonces[role] && nonceCountBefore >= actionRoles.length) {
      return res.status(409).json({ error: 'Nonce round already has enough participants' });
    }

    session.nonces[role] = { R_x, R_y };
    await saveSession(escrowId, session);

    const io = req.app.get('io');
    const nonceCount = Object.keys(session.nonces).length;

    if (nonceCount < actionRoles.length) {
      if (io) io.to(escrowId).emit('nonce_received', { count: nonceCount, needed: actionRoles.length });
      return res.json({ received: nonceCount, needed: actionRoles.length });
    }

    // Đủ nonces — tổng hợp R, tính PKagg và challenge e
    const roles = Object.keys(session.nonces);
    if (!rolesMatchAction(roles, action)) {
      session.nonces = {};
      session.zShares = {};
      session.signingRoles = null;
      session.signingAction = null;
      session.signingBitmap = null;
      session.round2Context = null;
      await saveSession(escrowId, session);
      return res.status(403).json({ error: `Signer roles do not match action '${action}' requirements` });
    }
    session.signingRoles = roles;

    const pkAgg = getPkAggForRoles(session, roles);
    const { R_x: agg_Rx, R_y: agg_Ry, R_addr } = aggregateNonces(Object.values(session.nonces));

    const msgHash = buildMsgHash(escrowId, action, bitmap, session.contractAddress, session.chainId);
    const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);

    // Lưu context cho round 2
    session.round2Context = { R_x: agg_Rx, R_y: agg_Ry, R_addr, pkAgg, msgHash, challenge, signerBitmap: bitmap };
    await saveSession(escrowId, session);

    // Broadcast challenge — mỗi bên dùng e để tính z_i = k_i + e * s_i
    if (io) {
      io.to(escrowId).emit('nonce_collected', { R_addr, challenge, msgHash, pkAgg, signerBitmap: bitmap });
    }

    return res.json({ ok: true, R_addr, challenge, msgHash, pkAgg, signerBitmap: bitmap });
  } catch (error) {
    console.error('Error in /nonce:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 2: Threshold Signing — Round 2 (z share submission) ───────────────

/**
 * POST /api/escrow/sign
 * Mỗi bên tự tính z_i = k_i + e * s_i ở FRONTEND rồi gửi z_i lên.
 * Backend tổng hợp z = z_1 + z_2 (mod ORDER).
 * Chữ ký cuối: (R_addr, z, e) — dùng để gọi contract.release/refund/timeoutRelease.
 *
 * Body: { escrowId, role, z }
 */
router.post('/sign', authMiddleware, escrowSignRateLimiter, async (req, res) => {
  try {
    const { escrowId, role, signerBitmap, z } = req.body;

    if (!escrowId || !role || signerBitmap === undefined || !z) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }

    const session = await checkSession(escrowId, res);
    if (!session) return;

    const participants = session.participants || session.parties;
    const expectedAddress = getRoleAddress(participants, role);
    if (!expectedAddress) {
      return res.status(403).json({ error: `Role '${role}' is not allowed in this escrow` });
    }

    const requesterAddress = normalizeAddress(req.user?.walletAddress);
    if (requesterAddress !== expectedAddress) {
      return res.status(403).json({ error: `Authenticated wallet is not allowed to submit z share for role '${role}'` });
    }

    if (!session.round2Context) {
      return res.status(400).json({ error: 'Round 1 not completed. Submit nonces first.' });
    }
    if (session.round2Context.signerBitmap !== Number(signerBitmap)) {
      return res.status(409).json({ error: 'Signer bitmap does not match current signing session' });
    }
    if (!session.signingRoles.includes(role)) {
      return res.status(403).json({ error: `Role '${role}' is not part of current signing session` });
    }
    if (!getActionSignerRoles(session.signingAction).includes(role)) {
      return res.status(403).json({ error: `Role '${role}' is not allowed for action '${session.signingAction}'` });
    }

    session.zShares[role] = z;
    await saveSession(escrowId, session);

    const io = req.app.get('io');
    const zCount = Object.keys(session.zShares).length;

    if (zCount < session.signingRoles.length) {
      if (io) io.to(escrowId).emit('z_received', { count: zCount, needed: session.signingRoles.length });
      return res.json({ received: zCount, needed: session.signingRoles.length });
    }

    // Đủ z shares — tổng hợp chữ ký cuối
    const { R_addr, pkAgg, msgHash, challenge: e } = session.round2Context;
    const z_agg = aggregateZShares(Object.values(session.zShares));

    // Đánh dấu action hoàn thành, dọn trạng thái signing
    session.completedActions.push(session.signingAction);
    session.nonces = {};
    session.zShares = {};
    session.signingRoles = null;
    session.signingAction = null;
    session.signingBitmap = null;
    session.round2Context = null;
    await saveSession(escrowId, session);

    const sig = { R_addr, z: z_agg, e, msgHash, signerBitmap: Number(signerBitmap) };

    if (io) io.to(escrowId).emit('schnorr_complete', sig);

    return res.json(sig);
  } catch (error) {
    console.error('Error in /sign:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/aggregate-key', async (req, res) => {
  try {
    const session = await checkSession(req.params.id, res);
    if (!session) return;

    const collection = getPubKeyCollectionSummary(session);
    if (collection.expired) {
      session.pubKeyCollectionState = 'EXPIRED';
      await saveSession(req.params.id, session);
      return res.status(410).json({
        error: 'Pubkey collection expired',
        collection: toCollectionPayload(collection)
      });
    }

    if (!collection.complete) {
      return res.status(409).json({
        error: 'Pubkey collection is incomplete. Submit all participant pubkeys first.',
        collection: toCollectionPayload(collection)
      });
    }

    const pkAgg = aggregatePubKeysForRoles(session.pubKeys, PARTICIPANT_ROLES);

    return res.json({
      ok: true,
      pkAgg,
      pkAggCoords: [pkAgg.x, pkAgg.y],
      collection: toCollectionPayload(collection)
    });
  } catch (error) {
    console.error('Error in /:id/aggregate-key:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/:id/status', async (req, res) => {
  const session = await checkSession(req.params.id, res);
  if (!session) return;
  const pubkeyCollection = getPubKeyCollectionStatus(session);
  res.json({
    status: session.status,
    signingAction: session.signingAction,
    signerBitmap: session.signingBitmap,
    nonceCount: Object.keys(session.nonces).length,
    zShareCount: Object.keys(session.zShares).length,
    parties: session.parties,
    completedActions: session.completedActions,
    pubkeyCollection: toCollectionPayload(pubkeyCollection)
  });
});

router.post('/deploy-vault', authMiddleware, async (req, res) => {
  try {
    const { escrowId } = req.body;
    const session = await getSession(escrowId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Chỉ buyer mới được deploy
    if (normalizeAddress(req.user.walletAddress) !== normalizeAddress(session.parties.buyer)) {
      return res.status(403).json({ error: 'Only buyer can deploy vault' });
    }

    if (session.contractAddress) {
      return res.json({ alreadyDeployed: true, contractAddress: session.contractAddress });
    }

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
    const factory = new ethers.Contract(process.env.FACTORY_ADDRESS, factoryAbi, adminWallet);

    const tx = await factory.createEscrow(
      session.parties.seller,
      session.parties.mediators,
      [session.precomputedPkAgg.x, session.precomputedPkAgg.y],
      session.amount,
      7,
      14
    );

    const receipt = await tx.wait(12); // Chờ 12 confirmations để tránh reorg
    const vaultAddress = receipt.contractAddress || receipt.logs[0].address; // Lấy địa chỉ Vault

    // Update DB trước khi emit
    await prisma.escrow.update({
      where: { id: escrowId },
      data: { contractAddress: vaultAddress }
    });

    session.contractAddress = vaultAddress;
    await saveSession(escrowId, session);

    // Emit WebSocket
    const io = req.app.get('io');
    if (io) {
      io.to(escrowId).emit('vault_deployed', {
        escrowId,
        contractAddress: vaultAddress,
        txHash: tx.hash
      });
    }

    res.json({ contractAddress: vaultAddress, txHash: tx.hash });
  } catch (error) {
    console.error('Error in /deploy-vault:', error);
    res.status(500).json({ error: error.message });
  }
});
export default router;
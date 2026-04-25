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

// Import ABI chuẩn từ file abi.js mà chúng ta đã tạo
import { factoryAbi } from '../abi.js';

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

// ─── Helpers (ĐÃ TÍCH HỢP AUTO-RECOVERY CỦA TECH LEAD) ──────────────────────

async function checkSession(escrowId, res) {
  let session = await getSession(escrowId, { allowExpired: true });
  
  if (!session) {
    console.log(`[TSS Recovery] RAM trống. Đang tự động khôi phục Session cho Escrow ${escrowId}...`);
    const escrowDb = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { buyer: true, seller: true, escrowMediators: { include: { mediator: true }, orderBy: { slot: 'asc' } } }
    });

    if (!escrowDb || !escrowDb.contractAddress) {
      if (res) res.status(404).json({ error: 'Không tìm thấy Escrow trong DB hoặc chưa Deploy Vault' });
      return null; 
    }

    const pubKeysDb = await prisma.pubKeySubmission.findMany({ where: { escrowId } });
    if (!pubKeysDb || pubKeysDb.length < 7) {
      if (res) res.status(400).json({ error: 'Chưa đủ 7 Public Keys trong Database để khôi phục' });
      return null;
    }

    session = {
      escrowId,
      chainId: process.env.CHAIN_ID || "11155111",
      contractAddress: escrowDb.contractAddress,
      participants: {
        buyer: normalizeAddress(escrowDb.buyer?.walletAddress),
        seller: normalizeAddress(escrowDb.seller?.walletAddress),
        mediators: escrowDb.escrowMediators.map(m => normalizeAddress(m.mediator?.walletAddress))
      },
      parties: {
        buyer: normalizeAddress(escrowDb.buyer?.walletAddress),
        seller: normalizeAddress(escrowDb.seller?.walletAddress),
        mediators: escrowDb.escrowMediators.map(m => normalizeAddress(m.mediator?.walletAddress))
      },
      pubKeys: {}, status: 'ACTIVE', completedActions: [], nonces: {}, zShares: {}, createdAt: Date.now()
    };
    pubKeysDb.forEach(pk => { session.pubKeys[pk.role] = pk.pubKey; });
    session.precomputedPkAgg = aggregatePubKeysForRoles(session.pubKeys, PARTICIPANT_ROLES);
    await saveSession(escrowId, session);
  }
  return session;
}

function buildMsgHash(escrowId, action, signerBitmap, contractAddress, chainId) {
  const id = escrowId.startsWith('0x') ? escrowId : ethers.id(escrowId);
  return ethers.solidityPackedKeccak256(['uint256', 'address', 'bytes32', 'string', 'uint8'], [BigInt(chainId).toString(), contractAddress, id, action, signerBitmap]);
}

function normalizePubKey(pubKeyHex) {
  if (typeof pubKeyHex !== 'string') throw new Error('Invalid public key format');
  const clean = pubKeyHex.replace('0x', '');
  if (clean.startsWith('04')) return clean;
  if (clean.startsWith('02') || clean.startsWith('03')) throw new Error('Compressed public keys are not supported. Please provide an uncompressed key.');
  if (clean.length === 128) return '04' + clean;
  throw new Error('Invalid public key format');
}

function isMissingTableError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('no such table') || message.includes('does not exist') || error?.code === 'P2021';
}

function normalizeAddress(value) { return String(value || '').trim().toLowerCase(); }
function toIsoTimestamp(timestampMs) { return Number.isFinite(Number(timestampMs)) ? new Date(Number(timestampMs)).toISOString() : null; }

function toCollectionPayload(summary) {
  return { state: summary.state, required: summary.required, received: summary.received, missingRoles: summary.missingRoles, dueAt: toIsoTimestamp(summary.dueAt) };
}

function getRoleAddress(participants, role) {
  if (!participants || typeof participants !== 'object') return null;
  if (role === 'buyer') return normalizeAddress(participants.buyer);
  if (role === 'seller') return normalizeAddress(participants.seller);
  if (!role.startsWith('mediator')) return null;
  const slot = Number(role.replace('mediator', ''));
  if (!Number.isInteger(slot) || slot < 1 || slot > MEDIATOR_COMMITTEE_SIZE) return null;
  const mediators = Array.isArray(participants.mediators) ? participants.mediators : [];
  return normalizeAddress(mediators[slot - 1]);
}

function buildParticipantsSnapshot(escrow) {
  const mediatorBySlot = new Array(MEDIATOR_COMMITTEE_SIZE).fill(null);
  for (const row of escrow.escrowMediators || []) {
    if (!row?.slot || row.slot < 1 || row.slot > MEDIATOR_COMMITTEE_SIZE) continue;
    mediatorBySlot[row.slot - 1] = normalizeAddress(row?.mediator?.walletAddress);
  }
  if (!normalizeAddress(escrow?.buyer?.walletAddress) || !normalizeAddress(escrow?.seller?.walletAddress)) return null;
  if (mediatorBySlot.some((address) => !address)) return null;
  return { buyer: normalizeAddress(escrow.buyer.walletAddress), seller: normalizeAddress(escrow.seller.walletAddress), mediators: mediatorBySlot };
}

async function resolveEscrowParticipants(escrowId) {
  const escrow = await prisma.escrow.findUnique({
    where: { id: escrowId },
    select: { id: true, buyer: { select: { walletAddress: true } }, seller: { select: { walletAddress: true } }, escrowMediators: { select: { slot: true, mediator: { select: { walletAddress: true } } }, orderBy: { slot: 'asc' } } }
  });
  if (!escrow) return null;
  const participants = buildParticipantsSnapshot(escrow);
  if (!participants) throw new Error('Escrow participants are incomplete. Expected buyer, seller, and 5 mediators.');
  return participants;
}

async function savePubKeySubmission(escrowId, role, pubKey) {
  if (pubKeyPersistenceDisabled || !prisma?.pubKeySubmission?.create) return { status: 'skipped' };
  try {
    await prisma.pubKeySubmission.create({ data: { escrowId, role, pubKey } });
    return { status: 'created' };
  } catch (error) {
    if (isMissingTableError(error)) { pubKeyPersistenceDisabled = true; return { status: 'skipped' }; }
    if (error?.code === 'P2002' && prisma?.pubKeySubmission?.findUnique) {
      const existing = await prisma.pubKeySubmission.findUnique({ where: { escrowId_role: { escrowId, role } }, select: { pubKey: true } });
      if (existing?.pubKey) {
        const existingPubKey = '0x' + normalizePubKey(existing.pubKey);
        const incomingPubKey = '0x' + normalizePubKey(pubKey);
        if (existingPubKey.toLowerCase() === incomingPubKey.toLowerCase()) return { status: 'idempotent' };
      }
      return { status: 'conflict' };
    }
    throw error;
  }
}

async function clearPubKeySubmissions(escrowId) {
  if (pubKeyPersistenceDisabled || !prisma?.pubKeySubmission?.deleteMany) return;
  try { await prisma.pubKeySubmission.deleteMany({ where: { escrowId } }); } 
  catch (error) { if (isMissingTableError(error)) pubKeyPersistenceDisabled = true; else throw error; }
}

function rolesMatchAction(roles, action) {
  const expected = [...getActionSignerRoles(action)].sort().join('+');
  const actual = [...new Set(roles)].sort().join('+');
  return expected === actual;
}

// ─── Phase 1: DKG ─────────────────────────────────────────────────────────────

router.post('/init', escrowInitRateLimiter, async (req, res) => {
  try {
    const { escrowId, chainId, contractAddress, buyerAddr, sellerAddr, mediatorAddrs, buyerPubKey, sellerPubKey, mediatorPubKeys } = req.body;
    if (!escrowId || !chainId || !contractAddress) return res.status(400).json({ error: 'Missing required fields' });
    if (!ethers.isAddress(contractAddress)) return res.status(400).json({ error: 'Invalid contractAddress' });

    let normalizedChainId;
    try { normalizedChainId = BigInt(chainId).toString(); } catch { return res.status(400).json({ error: 'Invalid chainId' }); }
    const normalizedContractAddress = ethers.getAddress(contractAddress);

    if (await hasSession(escrowId)) return res.status(409).json({ error: 'Session already exists for this escrowId' });

    const batchPayloadProvided = Boolean(buyerAddr || sellerAddr || mediatorAddrs || buyerPubKey || sellerPubKey || mediatorPubKeys);
    if (batchPayloadProvided) {
      if (!buyerAddr || !sellerAddr || !Array.isArray(mediatorAddrs) || mediatorAddrs.length !== 5 || !buyerPubKey || !sellerPubKey || !Array.isArray(mediatorPubKeys) || mediatorPubKeys.length !== 5) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const derivedBuyer = ethers.computeAddress('0x' + normalizePubKey(buyerPubKey));
      const derivedSeller = ethers.computeAddress('0x' + normalizePubKey(sellerPubKey));
      const derivedMediatorAddrs = mediatorPubKeys.map((pubKey) => ethers.computeAddress('0x' + normalizePubKey(pubKey)));

      if (derivedBuyer.toLowerCase() !== buyerAddr.toLowerCase()) return res.status(400).json({ error: 'buyerPubKey does not match buyerAddr' });
      if (derivedSeller.toLowerCase() !== sellerAddr.toLowerCase()) return res.status(400).json({ error: 'sellerPubKey does not match sellerAddr' });
      for (let index = 0; index < mediatorAddrs.length; index++) {
        if (derivedMediatorAddrs[index].toLowerCase() !== mediatorAddrs[index].toLowerCase()) return res.status(400).json({ error: `mediatorPubKeys[${index}] does not match mediatorAddrs[${index}]` });
      }

      const { session } = initDKG(escrowId, { buyerPubKey, sellerPubKey, mediatorPubKeys, participants: { buyer: buyerAddr.toLowerCase(), seller: sellerAddr.toLowerCase(), mediators: mediatorAddrs.map((address) => address.toLowerCase()) }, contractAddress: normalizedContractAddress, chainId: normalizedChainId });
      session.parties = { buyer: buyerAddr.toLowerCase(), seller: sellerAddr.toLowerCase(), mediators: mediatorAddrs.map((address) => address.toLowerCase()) };
      await saveSession(escrowId, session);
      const collection = getPubKeyCollectionSummary(session);
      return res.json({ ok: true, contractAddress: normalizedContractAddress, chainId: normalizedChainId, collection: toCollectionPayload(collection) });
    }

    const participants = await resolveEscrowParticipants(escrowId);
    if (!participants) return res.status(404).json({ error: 'Escrow not found' });
    await clearPubKeySubmissions(escrowId);
    const { session } = initIncrementalDKG(escrowId, { participants, contractAddress: normalizedContractAddress, chainId: normalizedChainId, dueAtMs: Date.now() + SESSION_TTL_MS });
    session.parties = participants;
    await saveSession(escrowId, session);
    const collection = getPubKeyCollectionSummary(session);
    return res.json({ ok: true, contractAddress: normalizedContractAddress, chainId: normalizedChainId, collection: toCollectionPayload(collection) });
  } catch (error) {
    if (/public key/i.test(error.message)) return res.status(400).json({ error: error.message });
    if (/participants are incomplete/i.test(error.message)) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

router.post('/pubkey/submit', authMiddleware, escrowPubKeySubmitRateLimiter, async (req, res) => {
  try {
    const { escrowId, role, pubKey } = req.body;
    if (!escrowId || !role || !pubKey) return res.status(400).json({ error: 'Missing required fields' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });

    const session = await checkSession(escrowId, res);
    if (!session) return;
    const io = req.app.get('io');
    const summaryBefore = getPubKeyCollectionSummary(session);
    if (summaryBefore.expired) {
      session.pubKeyCollectionState = 'EXPIRED';
      await saveSession(escrowId, session);
      if (io) io.to(escrowId).emit('pubkey_collection_expired', { escrowId, dueAt: toIsoTimestamp(summaryBefore.dueAt), expiredAt: new Date().toISOString() });
      return res.status(410).json({ error: 'Pubkey collection expired', collection: toCollectionPayload(getPubKeyCollectionSummary(session)) });
    }

    const normalizedPubKey = '0x' + normalizePubKey(pubKey);
    session.pubKeys = session.pubKeys || {};
    if (session.pubKeys[role]) {
      if (('0x' + normalizePubKey(session.pubKeys[role])).toLowerCase() === normalizedPubKey.toLowerCase()) {
        const collection = getPubKeyCollectionSummary(session);
        return res.json({ ok: true, state: collection.state, received: collection.received, required: collection.required, isIdempotent: true, collection: toCollectionPayload(collection) });
      }
      if (io) io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'CONFLICT' });
      return res.status(409).json({ error: `Role '${role}' already submitted a different pubKey` });
    }

    const expectedAddress = getRoleAddress(session.participants || session.parties, role);
    const requesterAddress = normalizeAddress(req.user?.walletAddress);
    if (!expectedAddress || requesterAddress !== expectedAddress || ethers.computeAddress(normalizedPubKey).toLowerCase() !== expectedAddress) {
      if (io) io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'AUTH_MISMATCH' });
      return res.status(403).json({ error: `Auth mismatch for role '${role}'` });
    }

    const persistenceResult = await savePubKeySubmission(escrowId, role, normalizedPubKey);
    if (persistenceResult.status === 'conflict') {
      if (io) io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'CONFLICT' });
      return res.status(409).json({ error: `Role '${role}' conflict in DB` });
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
      io.to(escrowId).emit('pubkey_received', { escrowId, role, received: summary.received, required: summary.required, missingRoles: summary.missingRoles });
      if (summary.complete) io.to(escrowId).emit('pubkey_collection_complete', { escrowId, received: summary.received, required: summary.required, completedAt: toIsoTimestamp(session.pubKeyAggregationCompletedAt || Date.now()) });
    }
    return res.json({ ok: true, state: summary.state, received: summary.received, required: summary.required, isIdempotent: false, collection: toCollectionPayload(summary) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 2: Threshold Signing — Round 1 (Nonce submission) ──────────────────
router.post('/nonce', authMiddleware, async (req, res) => {
  try {
    const { escrowId, role, action, signerBitmap, R_x, R_y } = req.body;
    if (!escrowId || !role || !action || signerBitmap === undefined || !R_x || !R_y) return res.status(400).json({ error: 'Missing required fields' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role` });

    const session = await checkSession(escrowId, res);
    if (!session) return;

    const expectedAddress = getRoleAddress(session.participants || session.parties, role);
    if (normalizeAddress(req.user?.walletAddress) !== expectedAddress) return res.status(403).json({ error: `Auth mismatch for role '${role}'` });

    const collection = getPubKeyCollectionSummary(session);
    if (!collection.complete) return res.status(409).json({ error: 'Pubkey collection is incomplete.', collection: toCollectionPayload(collection) });

    const actionRoles = getActionSignerRoles(action);
    if (!actionRoles.includes(role)) return res.status(403).json({ error: `Role '${role}' is not allowed for action '${action}'` });

    const bitmap = Number(signerBitmap);
    if (!session.signingAction) {
      session.signingAction = action; session.nonces = {}; session.zShares = {}; session.signingBitmap = bitmap;
    } else if (session.signingAction !== action || session.signingBitmap !== bitmap) {
      return res.status(409).json({ error: 'Different action or bitmap in progress' });
    }

    const normalizeCoordinate = (coord) => {
      const clean = coord.replace(/^0x/i, '').trim();
      if (!/^[0-9a-f]{1,64}$/i.test(clean)) throw new Error('Invalid hex');
      return '0x' + clean.padStart(64, '0');
    };

    let normalizedRx, normalizedRy;
    try { normalizedRx = normalizeCoordinate(R_x); normalizedRy = normalizeCoordinate(R_y); } 
    catch (e) { return res.status(400).json({ error: 'Invalid coordinate format' }); }

    session.nonces[role] = { R_x: normalizedRx, R_y: normalizedRy };
    await saveSession(escrowId, session);

    const io = req.app.get('io');
    const nonceCount = Object.keys(session.nonces).length;

    if (nonceCount < actionRoles.length) {
      if (io) io.to(escrowId).emit('nonce_received', { escrowId, count: nonceCount, needed: actionRoles.length });
      return res.json({ received: nonceCount, needed: actionRoles.length });
    }

    const roles = Object.keys(session.nonces);
    if (!rolesMatchAction(roles, action)) return res.status(403).json({ error: 'Signer roles do not match' });
    session.signingRoles = roles;

    const pkAgg = getPkAggForRoles(session, roles);
    const { R_x: agg_Rx, R_y: agg_Ry, R_addr } = aggregateNonces(Object.values(session.nonces));

    // VÁ LỖI: Lấy Vault thật chuẩn xác để băm chữ ký
    const dbEscrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
    const vaultAddr = dbEscrow?.contractAddress || session.contractAddress;

    // [CÚ CHỐT HẠ]: Đọc trực tiếp ID thực sự của Két sắt từ Blockchain để băm chữ ký
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const vaultContract = new ethers.Contract(vaultAddr, ['function escrowId() view returns (bytes32)'], provider);
    const trueChainEscrowId = await vaultContract.escrowId();

    const msgHash = buildMsgHash(trueChainEscrowId, action, bitmap, vaultAddr, session.chainId);
    const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);

    session.round2Context = { R_x: agg_Rx, R_y: agg_Ry, R_addr, pkAgg, msgHash, challenge, signerBitmap: bitmap };
    await saveSession(escrowId, session);

    if (io) {
      io.to(escrowId).emit('nonce_collected', { escrowId, R_addr, challenge, msgHash, pkAgg, signerBitmap: bitmap });
    }

    return res.json({ ok: true, R_addr, challenge, msgHash, pkAgg, signerBitmap: bitmap });
  } catch (error) {
    if (error.message.includes('bad point')) return res.status(400).json({ error: 'Invalid point coordinates' });
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 2: Threshold Signing — Round 2 (z share submission) ───────────────
router.post('/sign', authMiddleware, escrowSignRateLimiter, async (req, res) => {
  try {
    const { escrowId, role, signerBitmap, z } = req.body;
    if (!escrowId || !role || signerBitmap === undefined || !z) return res.status(400).json({ error: 'Missing required fields' });

    const session = await checkSession(escrowId, res);
    if (!session || !session.round2Context) return res.status(400).json({ error: 'Round 1 not completed' });

    session.zShares[role] = z;
    await saveSession(escrowId, session);

    const io = req.app.get('io');
    const zCount = Object.keys(session.zShares).length;

    if (zCount < session.signingRoles.length) {
      if (io) io.to(escrowId).emit('z_received', { escrowId, count: zCount, needed: session.signingRoles.length });
      return res.json({ received: zCount, needed: session.signingRoles.length });
    }

    const { R_addr, pkAgg, msgHash, challenge: e } = session.round2Context;
    const z_agg = aggregateZShares(Object.values(session.zShares));

    session.completedActions.push(session.signingAction);
    session.nonces = {};
    session.zShares = {};
    session.signingRoles = null;
    session.signingAction = null;
    session.signingBitmap = null;
    session.round2Context = null;
    await saveSession(escrowId, session);

    // VÁ LỖI: Trả về Vault thật cho Frontend
    const dbEscrowSign = await prisma.escrow.findUnique({ where: { id: escrowId } });
    const vaultContractAddress = dbEscrowSign?.contractAddress || session.contractAddress;

    if (!vaultContractAddress) {
      return res.status(400).json({ error: 'Vault contract address not found.' });
    }

    const sig = { 
      vaultContractAddress,
      R_addr, 
      z: z_agg, 
      e, 
      msgHash, 
      signerBitmap: Number(signerBitmap) 
    };

    if (io) io.to(escrowId).emit('schnorr_complete', { escrowId, ...sig });

    return res.json(sig);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/aggregate-key', async (req, res) => {
  const session = await checkSession(req.params.id, res);
  if (!session) return;
  const collection = getPubKeyCollectionSummary(session);

  // VÁ LỖI CÚ PHÁP: Đã xóa dòng lặp, chỉ còn 1 dòng duy nhất và chính xác.
  const releaseSignersAggKey = getActionSigners('release');
  const pkAgg = aggregatePubKeysForRoles(session.pubKeys, releaseSignersAggKey);

  return res.json({
    ok: true,
    pkAgg,
    pkAggCoords: [String(pkAgg.x), String(pkAgg.y)], // Đảm bảo trả về string cho an toàn
    collection: toCollectionPayload(collection)
  });
});

router.get('/:id/status', async (req, res) => {
  const session = await checkSession(req.params.id, res);
  if (!session) return;
  res.json({
    status: session.status, signingAction: session.signingAction, signerBitmap: session.signingBitmap,
    nonceCount: Object.keys(session.nonces).length, zShareCount: Object.keys(session.zShares).length,
    completedActions: session.completedActions, pubkeyCollection: toCollectionPayload(getPubKeyCollectionStatus(session))
  });
});

// ─── API DEPLOY VAULT ĐẦY ĐỦ (CỦA TECH LEAD - TỪ 1 ĐẾN 10) ─────────────────────────
router.post('/deploy-vault', authMiddleware, async (req, res) => {
  try {
    const { escrowId } = req.body;
    console.log("\n------------------------------------------------");
    console.log(`[Deploy] 1. Nhận yêu cầu deploy cho Escrow ID: ${escrowId}`);
    
    const session = await getSession(escrowId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    console.log("[Deploy] 2. Query TOÀN BỘ dữ liệu từ DB...");
    const escrowDb = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: {
        seller: true,
        escrowMediators: {
          include: { mediator: true },
          orderBy: { slot: 'asc' }
        }
      }
    });

    if (!escrowDb) return res.status(404).json({ error: 'Escrow not found in DB' });
    if (escrowDb.contractAddress) {
      console.log(`[Deploy] -> Đã có sẵn Contract: ${escrowDb.contractAddress}`);
      return res.json({ alreadyDeployed: true, contractAddress: escrowDb.contractAddress });
    }

    console.log("[Deploy] 3. Kết nối mạng Sepolia...");
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const adminWallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
    const factory = new ethers.Contract(process.env.FACTORY_ADDRESS, factoryAbi, adminWallet);

    console.log("[Deploy] 4. Đang trích xuất tham số...");
    const sellerAddress = escrowDb.seller?.walletAddress;
    const mediators = escrowDb.escrowMediators.map(row => row.mediator?.walletAddress);
    
    // VÁ LỖI CHÍ MẠNG: Deploy Két sắt với đúng Ổ KHÓA CỦA 5 NGƯỜI (trước đó nhánh main nhét 7 người vào đây gây Revert).
    const releaseSignersDeploy = getActionSigners('release');
    const pkAgg = aggregatePubKeysForRoles(session.pubKeys, releaseSignersDeploy);
    const pkX = String(pkAgg.x);
    const pkY = String(pkAgg.y);
    const amountInWei = ethers.parseEther(String(escrowDb.amount));

    console.log("[Deploy] 5. Đang lấy trước địa chỉ Vault (staticCall)...");
    const expectedVaultAddress = await factory.createEscrow.staticCall(
      sellerAddress, mediators, [pkX, pkY], amountInWei, 7, 14
    );
    console.log(`[Deploy] -> Địa chỉ Vault mới sẽ là: ${expectedVaultAddress}`);

    console.log("[Deploy] 6. Đang bắn giao dịch thật lên Blockchain (Vui lòng chờ)...");
    const tx = await factory.createEscrow(
      sellerAddress, mediators, [pkX, pkY], amountInWei, 7, 14
    );

    console.log(`[Deploy] 7. Giao dịch đã gửi thành công! Hash: ${tx?.hash}`);
    res.json({ txHash: tx?.hash, status: 'pending' });

    // Tiến trình ngầm TỰ ĐỘNG LƯU DATABASE
    (async () => {
      try {
        if (tx && typeof tx.wait === 'function') {
          await tx.wait(1);
          console.log(`[Deploy] 8. Block đã xác nhận! Hash: ${tx.hash}`);

          console.log(`[Deploy] 9. Đang lưu Vault Address vào Database...`);
          await prisma.escrow.update({
            where: { id: escrowId },
            data: { contractAddress: expectedVaultAddress }
          });
          console.log(`[Deploy] 10. HOÀN TẤT 100%! Frontend có thể nhấn F5 để tiếp tục.`);
          console.log("------------------------------------------------\n");
        }
      } catch (bgErr) {
        console.error("[Deploy] Lỗi Background tx wait:", bgErr);
      }
    })();

  } catch (error) {
    console.error('[Deploy] LỖI CẤP ĐỘ HỆ THỐNG:', error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

export default router;
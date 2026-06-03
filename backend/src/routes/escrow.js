import express from 'express';
import { deleteSession, getSession, getPubKeyCollectionStatus, hasSession, saveSession, isSigningExpired } from '../store/session.js';
import {
  aggregateWhenReady,
  aggregatePubKeysForRoles,
  PARTICIPANT_ROLES,
  getPubKeyCollectionSummary,
  getPkAggForRoles,
  ROLE_TO_ID,
  initDKG,
  initIncrementalDKG,
  SESSION_TTL_MS
} from '../crypto/dkg.js';
import { aggregateNoncesWithLagrange, computeChallenge, aggregateZSharesWithLagrange } from '../crypto/schnorr.js';
import { ethers } from 'ethers';
import { createRouteRateLimiter, getRateLimitConfig } from '../middleware/rate-limit.js';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { emitToEscrow } from '../lib/socket-emitter.js';

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

// ─── Helpers (ĐÃ TÍCH HỢP AUTO-RECOVERY CỦA TECH LEAD) ──────────────────────

async function getAllowedSignerRoles(escrowId) {
  let allowedRoles = [...VALID_ROLES]; 
  const dbEscrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
  
  const dispute = await prisma.dispute.findFirst({ 
      where: { escrowId, status: 'RESOLVED' },
      orderBy: { createdAt: 'desc' }
  });
  
  if (dispute) {
      const outcome = String(dispute.outcome || '').toUpperCase();
      if (outcome.includes('RELEASE') || outcome.includes('BUYER')) {
          allowedRoles = allowedRoles.filter(r => r !== 'seller');
      }
      else if (outcome.includes('RETURN') || outcome.includes('REFUND') || outcome.includes('SELLER')) {
          allowedRoles = allowedRoles.filter(r => r !== 'buyer');
      }
  }
  
  return allowedRoles;
}

async function checkSession(escrowId, res) {
  let session = await getSession(escrowId, { allowExpired: true });

  // TỰ ĐỘNG LÀM MỚI SESSION NẾU THIẾU/LỆCH MEDIATOR
  if (session) {
    const existingMediators = Array.isArray(session.participants?.mediators)
      ? session.participants.mediators
      : Array.isArray(session.parties?.mediators)
      ? session.parties.mediators
      : [];

    const missingOrShort = existingMediators.length !== MEDIATOR_COMMITTEE_SIZE || existingMediators.some((m) => !m);
    if (missingOrShort) {
      try {
        const escrowDb = await prisma.escrow.findUnique({
          where: { id: escrowId },
          include: { buyer: true, seller: true, escrowMediators: { include: { mediator: true }, orderBy: { slot: 'asc' } } }
        });
        const participantsSnapshot = escrowDb ? buildParticipantsSnapshot(escrowDb) : null;
        if (participantsSnapshot) {
          session.participants = participantsSnapshot;
          session.parties = participantsSnapshot;
        } else if (escrowDb) {
          // Fallback giữ nguyên đúng vị trí slot (không dùng map nén mảng)
          const fallbackMediators = new Array(MEDIATOR_COMMITTEE_SIZE).fill(null);
          for (const row of escrowDb.escrowMediators || []) {
            if (row?.slot && row.slot >= 1 && row.slot <= MEDIATOR_COMMITTEE_SIZE) {
              fallbackMediators[row.slot - 1] = normalizeAddress(row?.mediator?.walletAddress);
            }
          }
          session.participants = session.participants || {};
          session.parties = session.parties || {};
          session.participants.mediators = fallbackMediators;
          session.parties.mediators = fallbackMediators;
          session.participants.buyer = session.participants.buyer || normalizeAddress(escrowDb?.buyer?.walletAddress);
          session.participants.seller = session.participants.seller || normalizeAddress(escrowDb?.seller?.walletAddress);
          session.parties.buyer = session.parties.buyer || normalizeAddress(escrowDb?.buyer?.walletAddress);
          session.parties.seller = session.parties.seller || normalizeAddress(escrowDb?.seller?.walletAddress);
        }
        await saveSession(escrowId, session);
        console.log(`[TSS Recovery] Đã tự động làm mới cấu trúc Slot Mediator cho Session ${escrowId}`);
      } catch (err) {
        console.warn('[TSS Recovery] Could not refresh session participants from DB:', err?.message || err);
      }
    }
  }
  
  if (!session) {
    console.log(`[TSS Recovery] RAM trống. Đang tự động khôi phục Session cho Escrow ${escrowId}...`);
    const escrowDb = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { buyer: true, seller: true, escrowMediators: { include: { mediator: true }, orderBy: { slot: 'asc' } } }
    });

    // BẢN VÁ 1: Bỏ chốt chặn 404 (Không bắt buộc phải có contractAddress lúc gom Key)
    if (!escrowDb) {
      if (res) res.status(404).json({ error: 'Không tìm thấy Escrow trong DB' });
      return null; 
    }

    const pubKeysDb = await prisma.pubKeySubmission.findMany({ where: { escrowId } });
    
    const participantsSnapshot = buildParticipantsSnapshot(escrowDb);

    // TẠO MẢNG DỰ PHÒNG GIỮ NGUYÊN INDEX SLOT
    const fallbackMediators = new Array(MEDIATOR_COMMITTEE_SIZE).fill(null);
    for (const row of escrowDb.escrowMediators || []) {
      if (row?.slot && row.slot >= 1 && row.slot <= MEDIATOR_COMMITTEE_SIZE) {
        fallbackMediators[row.slot - 1] = normalizeAddress(row?.mediator?.walletAddress);
      }
    }

    // BẢN VÁ 2: Bỏ chốt chặn 400 (Cho phép tạo Session kể cả khi chưa đủ 7 Keys)
    session = {
      escrowId,
      chainId: process.env.CHAIN_ID || "11155111",
      contractAddress: escrowDb.contractAddress || null,
      participants: participantsSnapshot || {
        buyer: normalizeAddress(escrowDb.buyer?.walletAddress),
        seller: normalizeAddress(escrowDb.seller?.walletAddress),
        mediators: fallbackMediators // Đã thay thế hàm .map() gây lỗi
      },
      parties: participantsSnapshot || {
        buyer: normalizeAddress(escrowDb.buyer?.walletAddress),
        seller: normalizeAddress(escrowDb.seller?.walletAddress),
        mediators: fallbackMediators // Đã thay thế hàm .map() gây lỗi
      },
      pubKeys: {}, status: 'ACTIVE', completedActions: [], nonces: {}, zShares: {}, createdAt: Date.now()
    };

    if (pubKeysDb && pubKeysDb.length > 0) {
      pubKeysDb.forEach(pk => { session.pubKeys[pk.role] = pk.pubKey; });
    }

    // Chỉ gộp khóa tổng pkAgg khi thực sự đã đủ 7 Key
    if (pubKeysDb && pubKeysDb.length >= 7) {
      try {
        session.precomputedPkAgg = aggregatePubKeysForRoles(session.pubKeys, PARTICIPANT_ROLES);
        session.pubKeyCollectionState = 'COMPLETE';
      } catch (e) {
        console.warn(`[TSS Recovery] Lỗi khi gộp khóa: ${e.message}`);
        session.pubKeyCollectionState = 'PARTIAL';
      }
    } else {
      session.pubKeyCollectionState = 'PARTIAL';
    }
    
    // Khôi phục chữ ký (Nonces) nếu có
    try {
      const noncesDb = await prisma.nonceSubmission.findMany({
        where: { escrowId, expiresAt: { gt: new Date() } }
      });
      
      if (noncesDb && noncesDb.length > 0) {
        const firstNonce = noncesDb[0];
        session.signingAction = firstNonce.action;
        session.nonces = {};
        
        noncesDb.forEach(n => {
          session.nonces[n.role] = { R_x: n.nonceR_x, R_y: n.nonceR_y };
        });
        
        const roles = Object.keys(session.nonces);
        session.signingBitmap = calculateSignerBitmap(roles);
        
        if (roles.length >= 5) {
          const validation = validateSignerBitmap(session.signingBitmap, roles);
          if (validation.valid) {
          try {
            const pkAgg = getPkAggForRoles(session, roles);
            const { R_x: agg_Rx, R_y: agg_Ry, R_addr } = aggregateNoncesWithLagrange(session.nonces, ROLE_TO_ID);
            
            const vaultAddr = escrowDb.contractAddress || session.contractAddress;
            if (vaultAddr) {
              const vaultKey = await getVaultAggregateKey(vaultAddr);
              assertSignerSetMatchesVault(pkAgg, vaultKey.pkAgg, roles);
              
              const msgHash = buildMsgHash(vaultKey.trueChainEscrowId, firstNonce.action, session.signingBitmap, vaultAddr, vaultKey.chainId);
              const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);
              
              session.round2Context = { R_x: agg_Rx, R_y: agg_Ry, R_addr, pkAgg, msgHash, challenge, signerBitmap: session.signingBitmap };
              session.signingRoles = roles;
            }
          } catch (challengeError) {
            console.warn(`[TSS Recovery] Failed to auto-compute challenge: ${challengeError.message}`);
          }
        }
      }
    }
    } catch (nonceError) {
      console.warn(`[TSS Recovery] Không thể khôi phục nonce: ${nonceError.message}`);
    }
    
    await saveSession(escrowId, session);
  }
  return session;
}

function buildMsgHash(escrowId, action, signerBitmap, contractAddress, chainId) {
  const id = escrowId.startsWith('0x') ? escrowId : ethers.id(escrowId);
  return ethers.solidityPackedKeccak256(['uint256', 'address', 'bytes32', 'string', 'uint8'], [BigInt(chainId).toString(), contractAddress, id, action, signerBitmap]);
}

function normalizeUint256Hex(value) {
  return '0x' + BigInt(value).toString(16).padStart(64, '0').toLowerCase();
}

function samePkAgg(left, right) {
  return normalizeUint256Hex(left.x) === normalizeUint256Hex(right.x) &&
    normalizeUint256Hex(left.y) === normalizeUint256Hex(right.y);
}

async function getVaultAggregateKey(vaultAddr) {
  if (!vaultAddr) {
    const error = new Error('Vault contract address not found.');
    error.statusCode = 400;
    throw error;
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const vaultContract = new ethers.Contract(vaultAddr, [
    'function escrowId() view returns (bytes32)',
    'function pkAggX() view returns (uint256)',
    'function pkAggY() view returns (uint256)'
  ], provider);
  const [trueChainEscrowId, pkAggX, pkAggY, network] = await Promise.all([
    vaultContract.escrowId(),
    vaultContract.pkAggX(),
    vaultContract.pkAggY(),
    provider.getNetwork()
  ]);

  return {
    trueChainEscrowId,
    chainId: network.chainId.toString(),
    pkAgg: {
      x: normalizeUint256Hex(pkAggX),
      y: normalizeUint256Hex(pkAggY)
    }
  };
}

function assertSignerSetMatchesVault(pkAgg, deployedPkAgg, roles) {
  const deployedKeyIsUnset = BigInt(deployedPkAgg.x) === 0n && BigInt(deployedPkAgg.y) === 0n;
  if (deployedKeyIsUnset || samePkAgg(pkAgg, deployedPkAgg)) return;

  const error = new Error(`Signer set [${roles.join(', ')}] does not match the aggregate key deployed in the vault. Restart Round 1 with the roles used for vault deployment.`);
  error.statusCode = 409;
  throw error;
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

// Helper: Calculate signerBitmap from roles list
// bit 0: buyer, bit 1: seller, bits 2-6: mediator 1-5
function calculateSignerBitmap(roles) {
  let bitmap = 0;
  for (const role of roles) {
    if (role === 'buyer') bitmap |= 1; // bit 0
    else if (role === 'seller') bitmap |= 2; // bit 1
    else if (role.startsWith('mediator')) {
      const slot = Number(role.replace('mediator', ''));
      if (slot >= 1 && slot <= 5) bitmap |= (1 << (slot + 1)); // bits 2-6
    }
  }
  return bitmap;
}

// Helper: Validate signerBitmap - buyer OR seller must be included
function validateSignerBitmap(bitmap, submittedRoles) {
  const ALLOWED_BITS_MASK = 0x7f; // bits 0..6 only
  const CORE_ROLE_MASK = 0x03; // buyer (bit0) or seller (bit1)
  const MIN_SIGNERS = 5;

  const b = Number(bitmap);
  if (!Number.isFinite(b)) return { valid: false, error: 'Invalid bitmap' };
  if ((b & ~ALLOWED_BITS_MASK) !== 0) return { valid: false, error: 'Bitmap contains invalid bits' };

  // Count set bits using Kernighan's method (same idea as Solidity)
  let temp = b;
  let count = 0;
  while (temp) { temp &= temp - 1; count++; }

  if (count < MIN_SIGNERS) return { valid: false, error: `Need at least ${MIN_SIGNERS} signers, got ${count}` };

  // Ensure at least one core role (buyer or seller) is present
  if ((b & CORE_ROLE_MASK) === 0) return { valid: false, error: 'At least one core role (buyer or seller) must approve' };

  return { valid: true };
}

// ─── Phase 1: DKG ─────────────────────────────────────────────────────────────

router.post('/init', escrowInitRateLimiter, async (req, res) => {
  try {
    const { escrowId, chainId, contractAddress, buyerAddr, sellerAddr, mediatorAddrs, buyerPubKey, sellerPubKey, mediatorPubKeys } = req.body;
    if (!escrowId || !chainId) return res.status(400).json({ error: 'Missing required fields' });
    if (contractAddress && !ethers.isAddress(contractAddress)) {
      return res.status(400).json({ error: 'Invalid contractAddress format' });
    }

    let normalizedChainId;
    try { normalizedChainId = BigInt(chainId).toString(); } catch { return res.status(400).json({ error: 'Invalid chainId' }); }
    
    const normalizedContractAddress = contractAddress ? ethers.getAddress(contractAddress) : null;

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

      const summaryCheck = getPubKeyCollectionSummary(session);
      if (summaryCheck.complete || session.contractAddress) {
        return res.json({ ok: true, isIdempotent: true, message: 'DKG already complete. Ignored conflicting key.' });
      }

      if (io) io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'CONFLICT' });
      return res.status(409).json({ error: `Role '${role}' already submitted a different pubKey` });
    }

    const expectedAddress = getRoleAddress(session.participants || session.parties, role);
    const requesterAddress = normalizeAddress(req.user?.walletAddress);
    const isInternalWorker = req.headers['x-internal-auth'] === (process.env.INTERNAL_AUTH_TOKEN || 'internal_secret');

    if (!isInternalWorker) {
      if (!expectedAddress || requesterAddress !== expectedAddress) {
        if (io) io.to(escrowId).emit('pubkey_rejected', { escrowId, role, reason: 'AUTH_MISMATCH' });
        return res.status(403).json({ error: `Auth mismatch for role '${role}'` });
      }
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
      
      // Populate pkAgg into DB for all action combinations
      try {
        const buyerSellerPk = aggregatePubKeysForRoles(session.pubKeys, ['buyer', 'seller']);
        const buyerMediatorPk = aggregatePubKeysForRoles(session.pubKeys, ['buyer', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5']);
        const sellerMediatorPk = aggregatePubKeysForRoles(session.pubKeys, ['seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5']);
        
        await prisma.escrow.update({
          where: { id: escrowId },
          data: {
            pkAggBsX: String(buyerSellerPk.x),
            pkAggBsY: String(buyerSellerPk.y),
            pkAggBmX: String(buyerMediatorPk.x),
            pkAggBmY: String(buyerMediatorPk.y),
            pkAggSmX: String(sellerMediatorPk.x),
            pkAggSmY: String(sellerMediatorPk.y)
          }
        });
        console.log(`[DKG] Populated pkAgg into DB for escrow ${escrowId}`);
      } catch (dbError) {
        console.warn(`[DKG] Failed to populate pkAgg into DB: ${dbError.message}`);
      }
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

    const allowedRoles = await getAllowedSignerRoles(escrowId);
    if (!allowedRoles.includes(role)) return res.status(403).json({ error: `Role '${role}' is not allowed to sign according to the dispute outcome.` });

    const bitmap = Number(signerBitmap);
    if (!session.signingAction) {
      session.signingAction = action; session.nonces = {}; session.zShares = {}; session.signingBitmap = 0; session.signingStartedAt = Date.now(); // Start with 0, will update as nonces are submitted
    } else if (session.signingAction !== action) {
      return res.status(409).json({ error: 'Different action in progress' });
    }

    // Check signing timeout (6 hours)
    if (isSigningExpired(session)) {
      return res.status(410).json({ error: 'Signing session expired. Please restart signing.' });
    }

    const normalizeCoordinate = (coord) => {
      const clean = coord.replace(/^0x/i, '').trim();
      if (!/^[0-9a-f]{1,64}$/i.test(clean)) throw new Error('Invalid hex');
      return '0x' + clean.padStart(64, '0');
    };

    let normalizedRx, normalizedRy;
    try { normalizedRx = normalizeCoordinate(R_x); normalizedRy = normalizeCoordinate(R_y); } 
    catch (e) { return res.status(400).json({ error: 'Invalid coordinate format' }); }

    // Check if nonce already exists for this role
    if (session.nonces[role]) {
      const existingRx = session.nonces[role].R_x;
      const existingRy = session.nonces[role].R_y;
      
      // Same nonce value - idempotent submission
      if (existingRx === normalizedRx && existingRy === normalizedRy) {
        const nonceCount = Object.keys(session.nonces).length;
        console.log(`[Nonce] Idempotent submission from role '${role}' for escrow ${escrowId}`);

        // Recalculate signerBitmap based on actual submitted roles
        const submittedRoles = Object.keys(session.nonces);
        session.signingBitmap = calculateSignerBitmap(submittedRoles);

        // If Round 1 is complete, return the round2Context
        if (session.round2Context) {
          return res.json({
            state: 'round2_ready',
            received: nonceCount,
            needed: 5,
            isIdempotent: true,
            round2Context: session.round2Context,
            signerBitmap: session.signingBitmap,
            message: 'Nonce already submitted with same values. Round 1 already complete.'
          });
        }
        
        // If enough nonces collected but round2Context missing, auto-compute challenge
        if (nonceCount >= 5) {
          const roles = Object.keys(session.nonces);
          const validation = validateSignerBitmap(session.signingBitmap, roles);
          if (validation.valid) {
            try {
              const dbEscrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
              const vaultAddr = dbEscrow?.contractAddress || session.contractAddress;
              const pkAgg = getPkAggForRoles(session, roles);
              const vaultKey = await getVaultAggregateKey(vaultAddr);
              assertSignerSetMatchesVault(pkAgg, vaultKey.pkAgg, roles);
              const { R_x: agg_Rx, R_y: agg_Ry, R_addr } = aggregateNoncesWithLagrange(session.nonces, ROLE_TO_ID);
              
              const msgHash = buildMsgHash(vaultKey.trueChainEscrowId, action, session.signingBitmap, vaultAddr, vaultKey.chainId);
              const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);
              
              session.round2Context = { R_x: agg_Rx, R_y: agg_Ry, R_addr, pkAgg, msgHash, challenge, signerBitmap: session.signingBitmap };
              session.signingRoles = roles;
              await saveSession(escrowId, session);
              
              console.log(`[Nonce] Auto-computed challenge on idempotent submission: R_addr=${R_addr}, challenge=${challenge}`);
              
              return res.json({ 
                state: 'round2_ready',
                received: nonceCount,
                needed: 5,
                isIdempotent: true,
                round2Context: session.round2Context,
                signerBitmap: session.signingBitmap,
                message: 'Nonce already submitted with same values. Round 1 now complete.'
              });
            } catch (challengeError) {
              if (challengeError.statusCode) {
                return res.status(challengeError.statusCode).json({ error: challengeError.message });
              }
              console.warn(`[Nonce] Failed to auto-compute challenge: ${challengeError.message}`);
            }
          }
        }
        
        return res.json({ 
          received: nonceCount, 
          needed: 5, 
          isIdempotent: true,
          signerBitmap: session.signingBitmap,
          message: 'Nonce already submitted with same values'
        });
      }
      
      // Different nonce value - return current state and existing nonce to allow FE to sync
      console.warn(`[Nonce] Different nonce value from role '${role}' for escrow ${escrowId}. Returning current state and existing nonce.`);
      const nonceCount = Object.keys(session.nonces).length;
      const submittedRoles = Object.keys(session.nonces);
      
      // Return existing nonce for this role to allow FE to sync
      const existingNonceForRole = session.nonces[role];
      
      // If Round 1 is complete, return the round2Context
      if (session.round2Context) {
        return res.json({ 
          state: 'round2_ready',
          received: nonceCount,
          needed: 5,
          submittedRoles,
          round2Context: session.round2Context,
          existingNonce: existingNonceForRole ? { R_x: existingNonceForRole.R_x, R_y: existingNonceForRole.R_y } : null,
          signerBitmap: session.signingBitmap,
          message: 'Your nonce differs from submitted value. Round 1 already complete. Use existing nonce from backend.'
        });
      }
      
      // Round 1 still in progress
      return res.json({ 
        state: 'round1_in_progress',
        received: nonceCount,
        needed: 5,
        submittedRoles,
        existingNonce: existingNonceForRole ? { R_x: existingNonceForRole.R_x, R_y: existingNonceForRole.R_y } : null,
        signerBitmap: session.signingBitmap,
        message: 'Your nonce differs from submitted value. Round 1 still in progress. Use existing nonce from backend.'
      });
    }

    session.nonces[role] = { R_x: normalizedRx, R_y: normalizedRy };

    // Update signerBitmap based on actual submitted roles
    const submittedRoles = Object.keys(session.nonces);
    session.signingBitmap = calculateSignerBitmap(submittedRoles);

    // AUTO-APPROVE: When user submits nonce, they are implicitly approving the action
    try {
      let user = null;

      // 1) Primary: lookup by checksummed address (Ethers standard)
      try {
        const checksummed = ethers.getAddress(String(req.user?.walletAddress || '').trim());
        user = await prisma.user.findUnique({ where: { walletAddress: checksummed } });
      } catch (e) {
        // ignore and fallback
      }

      // 2) Fallback: findFirst using lowercased stored value
      if (!user) {
        user = await prisma.user.findFirst({
          where: { walletAddress: String(req.user?.walletAddress || '').trim().toLowerCase() }
        });
      }

      if (user) {
        await prisma.approval.upsert({
          where: { escrowId_action_userId: { escrowId, action, userId: user.id } },
          update: {},
          create: { escrowId, action, userId: user.id }
        });
      }
    } catch (approvalError) {
      console.warn(`[Nonce] Failed to create approval record: ${approvalError.message}`);
    }

    // Save nonce to NonceSubmission table for persistence
    try {
      const nonceTTL = 30 * 60 * 1000; // 30 minutes TTL
      await prisma.nonceSubmission.upsert({
        where: { escrowId_action_role: { escrowId, action, role } },
        update: {
          nonceR_x: normalizedRx,
          nonceR_y: normalizedRy,
          expiresAt: new Date(Date.now() + nonceTTL)
        },
        create: {
          escrowId,
          action,
          role,
          nonceR_x: normalizedRx,
          nonceR_y: normalizedRy,
          expiresAt: new Date(Date.now() + nonceTTL)
        }
      });
    } catch (nonceError) {
      // Log but don't fail - this is a best-effort operation
      console.warn(`[Nonce] Failed to save nonce to database: ${nonceError.message}`);
    }

    await saveSession(escrowId, session);

    const io = req.app.get('io');
    const nonceCount = Object.keys(session.nonces).length;

    if (nonceCount < 5) {
      if (io) io.to(escrowId).emit('nonce_received', { escrowId, count: nonceCount, needed: 5 });
      return res.json({ received: nonceCount, needed: 5, signerBitmap: session.signingBitmap });
    }

    const roles = Object.keys(session.nonces);
    const validation = validateSignerBitmap(session.signingBitmap, roles);
    if (!validation.valid) return res.status(403).json({ error: validation.error });
    session.signingRoles = roles;

    const pkAgg = getPkAggForRoles(session, roles);

    // VÁ LỖI: Lấy Vault thật chuẩn xác để băm chữ ký
    const dbEscrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
    const vaultAddr = dbEscrow?.contractAddress || session.contractAddress;
    const vaultKey = await getVaultAggregateKey(vaultAddr);
    assertSignerSetMatchesVault(pkAgg, vaultKey.pkAgg, roles);
    const { R_x: agg_Rx, R_y: agg_Ry, R_addr } = aggregateNoncesWithLagrange(session.nonces, ROLE_TO_ID);

    // Đọc trực tiếp ID thực sự của Két sắt từ Blockchain để băm chữ ký
    const msgHash = buildMsgHash(vaultKey.trueChainEscrowId, action, session.signingBitmap, vaultAddr, vaultKey.chainId);
    const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);

    console.log(`[TSS Round 2] Escrow: ${escrowId}`);
    console.log(`[TSS Round 2] Action: ${action}, Bitmap: ${session.signingBitmap}`);
    console.log(`[TSS Round 2] Vault: ${vaultAddr}, ChainId: ${vaultKey.chainId}`);
    console.log(`[TSS Round 2] escrowId (raw): ${vaultKey.trueChainEscrowId}`);
    console.log(`[TSS Round 2] msgHash: ${msgHash}`);
    console.log(`[TSS Round 2] pkAgg: x=${pkAgg.x}, y=${pkAgg.y}`);
    console.log(`[TSS Round 2] R_addr: ${R_addr}, challenge (e): ${challenge}`);

    session.round2Context = { R_x: agg_Rx, R_y: agg_Ry, R_addr, pkAgg, msgHash, challenge, signerBitmap: session.signingBitmap };
    await saveSession(escrowId, session);

    if (io) {
      io.to(escrowId).emit('nonce_collected', { escrowId, R_addr, challenge, msgHash, pkAgg, signerBitmap: session.signingBitmap });
    }

    return res.json({ ok: true, R_addr, challenge, msgHash, pkAgg, signerBitmap: session.signingBitmap });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
    if (!session.signingRoles?.includes(role)) return res.status(403).json({ error: `Role '${role}' did not participate in Round 1` });

    // Check signing timeout (6 hours)
    if (isSigningExpired(session)) {
      return res.status(410).json({ error: 'Signing session expired. Please restart signing.' });
    }

    session.zShares[role] = z;
    await saveSession(escrowId, session);

    const io = req.app.get('io');
    const zCount = Object.keys(session.zShares).length;

    if (zCount < session.signingRoles.length) {
      if (io) io.to(escrowId).emit('z_received', { escrowId, count: zCount, needed: session.signingRoles.length });
      return res.json({ received: zCount, needed: session.signingRoles.length });
    }

    const { R_addr, pkAgg, msgHash, challenge: e, signerBitmap: expectedBitmap } = session.round2Context;
    
    // VALIDATE signerBitmap: Must match expected bitmap from nonce collection
    // and must have buyer or seller approval
    const submittedBitmap = Number(signerBitmap);
    if (submittedBitmap !== expectedBitmap) {
      return res.status(400).json({ 
        error: `Signer bitmap mismatch. Expected: ${expectedBitmap}, got: ${submittedBitmap}` 
      });
    }
    
    // Validate bitmap structure (minimum 5 signers, core role required)
    const validation = validateSignerBitmap(submittedBitmap, session.signingRoles);
    if (!validation.valid) {
      return res.status(400).json({ error: `Invalid signer bitmap: ${validation.error}` });
    }
    
    // SSS aggregation: z = (z_1*λ_1 + z_2*λ_2 + ... + z_n*λ_n) mod ORDER.
    const z_agg = aggregateZSharesWithLagrange(session.zShares, ROLE_TO_ID);

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

  // Lấy khóa tổng quát của cả 7 người 
  const happyPathRoles = ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3'];
  const pkAgg = getPkAggForRoles(session, happyPathRoles);

  return res.json({
    ok: true,
    pkAggRelease: pkAgg,  pkAggReleaseCoords:  [pkAgg.x, pkAgg.y],
    pkAggRefund: pkAgg,   pkAggRefundCoords:   [pkAgg.x, pkAgg.y],
    pkAggTimeout: pkAgg,  pkAggTimeoutCoords:  [pkAgg.x, pkAgg.y],
    pkAgg: pkAgg,
    pkAggCoords: [pkAgg.x, pkAgg.y]
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

// ─── Approval API ─────────────────────────────────────────────────────────────

// Get approval status for an escrow action
router.get('/:id/approvals', authMiddleware, async (req, res) => {
  try {
    const { id: escrowId } = req.params;
    const { action } = req.query;
    
    if (!escrowId || !action) {
      return res.status(400).json({ error: 'Missing required fields: escrowId, action' });
    }
    
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Allowed: ${VALID_ACTIONS.join(', ')}` });
    }
    
    // Get escrow with buyer/seller info
    const escrow = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { buyer: true, seller: true, escrowMediators: { include: { mediator: true }, orderBy: { slot: 'asc' } } }
    });
    
    if (!escrow) {
      return res.status(404).json({ error: 'Escrow not found' });
    }
    
    // Get approvals from database
    const approvals = await prisma.approval.findMany({
      where: { escrowId, action },
      include: { user: { select: { id: true, walletAddress: true } } }
    });
    
    // Map approvals to roles
    const approvedRoles = [];
    for (const approval of approvals) {
      if (approval.user.walletAddress === escrow.buyer.walletAddress) {
        approvedRoles.push('buyer');
      } else if (approval.user.walletAddress === escrow.seller.walletAddress) {
        approvedRoles.push('seller');
      } else {
        // Check if it's a mediator
        const mediatorSlot = escrow.escrowMediators.findIndex(m => m.mediator.walletAddress === approval.user.walletAddress);
        if (mediatorSlot !== -1) {
          approvedRoles.push(`mediator${mediatorSlot + 1}`);
        }
      }
    }
    
    // Calculate expected signerBitmap
    const expectedBitmap = calculateSignerBitmap(approvedRoles);
    
    // Validate bitmap
    const validation = validateSignerBitmap(expectedBitmap, approvedRoles);
    
    res.json({
      escrowId,
      action,
      approvals: approvals.map(a => ({
        userId: a.userId,
        walletAddress: a.user.walletAddress,
        approvedAt: a.approvedAt
      })),
      approvedRoles,
      expectedSignerBitmap: expectedBitmap,
      isValid: validation.valid,
      validationError: validation.error || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API LƯU ĐỊA CHỈ VAULT SAU KHI BUYER DEPLOY (VRF ARCHITECTURE) ─────────
// POST /api/escrow/record-deploy
// Body: { escrowId, txHash }
router.post('/record-deploy', authMiddleware, async (req, res) => {
  try {
    const { escrowId, txHash } = req.body;
    if (!escrowId || !txHash) return res.status(400).json({ error: 'escrowId and txHash are required' });
    const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
    const isSameAddress = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
    if (!FACTORY_ADDRESS) return res.status(500).json({ error: 'FACTORY_ADDRESS is not configured' });

    console.log(`[Record Deploy] Bắt đầu xác nhận giao dịch ${txHash} cho Escrow ${escrowId}`);
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

    // Chờ biên lai (receipt) từ mạng lưới (thử tối đa 30 lần)
    let receipt = await provider.getTransactionReceipt(txHash);
    const maxAttempts = 30;
    let attempt = 0;
    while (!receipt && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2000));
      receipt = await provider.getTransactionReceipt(txHash);
      attempt += 1;
    }

    if (!receipt) return res.status(404).json({ error: 'Transaction receipt not found yet' });
    if (receipt.status === 0) return res.status(400).json({ error: 'Transaction failed on-chain' });
    if (!isSameAddress(receipt.to, FACTORY_ADDRESS)) {
      return res.status(400).json({ error: 'Transaction is not sent to the factory contract' });
    }

    // Phân tích Logs để tìm sự kiện EscrowCreatedEvent và lấy luôn chainEscrowId
    const iface = new ethers.Interface(factoryAbi);
    let foundVaultAddress = null;
    let foundChainEscrowId = null;

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && (parsed.name === 'EscrowCreatedEvent' || parsed.name === 'EscrowCreated')) {
          foundVaultAddress = parsed.args?.escrowAddress || parsed.args?.[0];
          foundChainEscrowId = parsed.args?.escrowId || parsed.args?.[1];
          break;
        }
      } catch (e) {
        // Bỏ qua các log không thuộc về Factory
      }
    }

    if (!foundVaultAddress) {
      return res.status(404).json({ error: 'EscrowCreatedEvent not found in tx logs' });
    }
    
    if (!foundChainEscrowId) {
      return res.status(422).json({ error: 'EscrowCreated event does not contain chainEscrowId' });
    }

    // idempotency check: Nếu đã có cùng contractAddress trong DB thì trả về thành công luôn, không lỗi, tránh UI update lại
    const existingEscrow = await prisma.escrow.findUnique({
      where: { id: escrowId },
      select: { id: true, contractAddress: true, chainEscrowId: true, pkAggBsX: true, pkAggBsY: true }
    });

    if (!existingEscrow) {
      return res.status(404).json({ error: 'Escrow not found in database' });
    }

    // Bắt buộc phải có DKG mới được Deploy
    if (!existingEscrow.pkAggBsX || !existingEscrow.pkAggBsY) {
      return res.status(409).json({ error: 'Aggregated key missing in DB. Complete DKG before recording on-chain deploy.' });
    }

    if (existingEscrow.contractAddress) {
      if (isSameAddress(existingEscrow.contractAddress, foundVaultAddress)) {
        return res.json({
          ok: true,
          contractAddress: foundVaultAddress,
          chainEscrowId: foundChainEscrowId,
          isIdempotent: true
        });
      }

      return res.status(409).json({
        error: 'Escrow already has a different contractAddress',
        currentContractAddress: existingEscrow.contractAddress,
        newContractAddress: foundVaultAddress
      });
    }

    console.log(`[Record Deploy] Két sắt: ${foundVaultAddress}. Mã định danh Blockchain (chainEscrowId): ${foundChainEscrowId}. Đang lưu DB...`);

    // LƯU CẢ ĐỊA CHỈ LẪN MÃ ĐỊNH DANH VÀO DATABASE
    await prisma.escrow.update({
      where: { id: escrowId },
      data: { 
        contractAddress: foundVaultAddress,
        chainEscrowId: foundChainEscrowId,
        status: 'INITIALIZED'
      }
    });

    // Bắn sự kiện Socket để Giao diện Buyer/Seller tự động mở nút Nạp tiền
    const io = req.app.get('io');
    if (io) {
      io.to(escrowId).emit('vault_deployed', {
        escrowId,
        contractAddress: foundVaultAddress,
        txHash,
        blockNumber: receipt.blockNumber,
        status: 'INITIALIZED'
      });
    }
    // Báo cho Worker biết có Vault mới để nó đưa vào danh sách theo dõi (Chữa bệnh Treo Deploy lần 2)
    if (io) {
      io.emit('subscribe_vault', { contractAddress: foundVaultAddress });
    }

    console.log(`[Record Deploy] Thành công! Escrow ${escrowId} -> ${foundVaultAddress}`);
    return res.json({ ok: true, contractAddress: foundVaultAddress });
  } catch (error) {
    console.error('Error in POST /escrow/record-deploy:', error);
    return res.status(500).json({ error: error.message || String(error) });
  }
});

// ─── Reset Signing Session API ────────────────────────────────────────────────
// Called by frontend when on-chain execution fails (InvalidSignature)
router.post('/:id/reset-signing', authMiddleware, async (req, res) => {
  try {
    const { id: escrowId } = req.params;
    const { action, reason } = req.body;

    if (!escrowId) {
      return res.status(400).json({ error: 'Missing escrowId' });
    }

    let session = await getSession(escrowId);
    if (!session) {
      console.log(`[ResetSigning] Session not found. Auto-creating session and restoring public keys from database for escrow ${escrowId}`);
      const escrowDb = await prisma.escrow.findUnique({
        where: { id: escrowId },
        include: { buyer: true, seller: true, escrowMediators: { include: { mediator: true }, orderBy: { slot: 'asc' } } }
      });

      if (!escrowDb || !escrowDb.contractAddress) {
        return res.status(404).json({ error: 'Escrow not found or vault not deployed' });
      }

      const pubKeysDb = await prisma.pubKeySubmission.findMany({ where: { escrowId } });
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

    if (pubKeysDb && pubKeysDb.length > 0) {
      pubKeysDb.forEach(pk => { session.pubKeys[pk.role] = pk.pubKey; });
    }

    // CHỈ TỔNG HỢP KHÓA (AGGREGATE) NẾU ĐÃ THU THẬP ĐỦ 7 KEYS
    if (pubKeysDb && pubKeysDb.length >= 7) {
      try {
        session.precomputedPkAgg = aggregatePubKeysForRoles(session.pubKeys, PARTICIPANT_ROLES);
        session.pubKeyCollectionState = 'COMPLETE';
      } catch (e) {
        console.warn(`[TSS Recovery] Lỗi khi gộp khóa: ${e.message}`);
        session.pubKeyCollectionState = 'PARTIAL';
      }
    } else {
      session.pubKeyCollectionState = 'PARTIAL';
    }
      await saveSession(escrowId, session);
      console.log(`[ResetSigning] Session auto-created and public keys restored for escrow ${escrowId}`);
    }

    console.log(`[ResetSigning] Resetting signing for escrow ${escrowId}. Reason: ${reason || 'unknown'}`);

    // Clear session signing state
    session.nonces = {};
    session.zShares = {};
    session.signingRoles = null;
    session.signingAction = null;
    session.signingBitmap = null;
    session.round2Context = null;

    // Remove signingAction from completedActions if it was added
    if (action && session.completedActions.includes(action)) {
      session.completedActions = session.completedActions.filter(a => a !== action);
    }

    await saveSession(escrowId, session);

    // Delete NonceSubmission records from database
    try {
      await prisma.nonceSubmission.deleteMany({
        where: {
          escrowId,
          action: action || session.signingAction || 'release'
        }
      });
      console.log(`[ResetSigning] Deleted NonceSubmission records for ${escrowId}`);
    } catch (dbError) {
      console.warn(`[ResetSigning] Failed to delete NonceSubmission: ${dbError.message}`);
    }

    // Delete Approval records for the action
    try {
      await prisma.approval.deleteMany({
        where: {
          escrowId,
          action: action || session.signingAction || 'release'
        }
      });
      console.log(`[ResetSigning] Deleted Approval records for ${escrowId}, action: ${action || session.signingAction || 'release'}`);
    } catch (dbError) {
      console.warn(`[ResetSigning] Failed to delete Approvals: ${dbError.message}`);
    }

    // Emit event to frontend
    const io = req.app.get('io');
    if (io) {
      io.to(escrowId).emit('signing_reset', {
        escrowId,
        action,
        reason: reason || 'On-chain execution failed',
        message: 'Signing session has been reset. All participants must restart with fresh nonces.'
      });
    }

    res.json({
      ok: true,
      message: 'Signing session reset successfully',
      escrowId,
      action
    });
  } catch (error) {
    console.error('[ResetSigning] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

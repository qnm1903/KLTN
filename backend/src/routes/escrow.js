import express from 'express';
import { deleteSession, getSession, getPubKeyCollectionStatus, hasSession, saveSession, isSigningExpired } from '../store/session.js';
import {

  aggregatePubKeysForRoles,
  PARTICIPANT_ROLES,
  getPubKeyCollectionSummary,
  getPkAggForRoles,
  ROLE_TO_ID,
  initDKG,
  initIncrementalDKG,
  SESSION_TTL_MS
} from '../crypto/dkg.js';
import { aggregateNoncesWithLagrange, computeChallenge, aggregateZSharesWithLagrange, aggregatePubKeysWithLagrange, computeBindingFactors, computeEffectiveNonces, verifyZShare } from '../crypto/schnorr.js';
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
  let isDisputeResolution = false;

  const dispute = await prisma.dispute.findFirst({
    where: { escrowId, status: 'RESOLVED' },
    orderBy: { createdAt: 'desc' }
  });

  if (dispute) {
    isDisputeResolution = true;
    // Canonicalize outcome (incl. legacy values). Exclude the losing core party from the signer set.
    //   RELEASE = funds to seller (seller wins) → buyer is the loser
    //   REFUND  = funds to buyer  (buyer wins)  → seller is the loser
    //   SPLIT   = 50/50 → both may sign
    const raw = String(dispute.outcome || '').toUpperCase();
    let outcome = 'OTHER';
    if (raw === 'RELEASE' || raw === 'RELEASE_TO_SELLER' || raw === 'RETURN_TO_SELLER' || raw === 'RETURN') outcome = 'RELEASE';
    else if (raw === 'REFUND' || raw === 'REFUND_TO_BUYER' || raw === 'RELEASE_TO_BUYER') outcome = 'REFUND';
    else if (raw === 'SPLIT') outcome = 'SPLIT';

    if (outcome === 'RELEASE') {
      allowedRoles = allowedRoles.filter(r => r !== 'buyer');
    } else if (outcome === 'REFUND') {
      allowedRoles = allowedRoles.filter(r => r !== 'seller');
    }
  }

  return { allowedRoles, isDisputeResolution };
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

    // Sync pubkeys from PubKeySubmission DB into session — handles case where session was
    // persisted with partial pubkeys (e.g., backend restarted mid-submission flow).
    try {
      const summary = getPubKeyCollectionSummary(session);
      if (!summary.complete && prisma?.pubKeySubmission) {
        const pubKeysDb = await prisma.pubKeySubmission.findMany({ where: { escrowId } });
        if (pubKeysDb && pubKeysDb.length > 0) {
          session.pubKeys = session.pubKeys || {};
          let merged = false;
          for (const pk of pubKeysDb) {
            if (!session.pubKeys[pk.role]) {
              session.pubKeys[pk.role] = pk.pubKey;
              merged = true;
            }
          }
          if (merged) {
            const newSummary = getPubKeyCollectionSummary(session);
            session.pubKeyCollectionState = newSummary.complete ? 'COMPLETE' : 'PARTIAL';
            await saveSession(escrowId, session);
            console.log(`[TSS Recovery] Synced ${pubKeysDb.length} pubkeys from DB for escrow ${escrowId}`);
          }
        }
      }
    } catch (err) {
      console.warn('[TSS Recovery] Could not sync pubkeys from DB:', err?.message || err);
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
        // Group nonces by action to prevent mixing release-nonces with refund-nonces.
        // Without this, the aggregated R_agg and challenge 'e' would be computed from
        // a mix of both actions, breaking on-chain verification.
        const noncesByAction = {};
        noncesDb.forEach(n => {
          if (!noncesByAction[n.action]) noncesByAction[n.action] = [];
          noncesByAction[n.action].push(n);
        });

        // Pick the action group that has the most nonces (most likely the active session).
        // Tie-break by action name for determinism.
        const [activeAction, activeNonces] = Object.entries(noncesByAction)
          .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];

        console.log(`[TSS Recovery] Restoring ${activeNonces.length} nonce(s) for action '${activeAction}' (discarding ${noncesDb.length - activeNonces.length} nonce(s) from other actions).`);

        session.signingAction = activeAction;
        session.nonces = {};

        activeNonces.forEach(n => {
          // Khôi phục cả FROST dual-nonce (R1/R2) nếu có, để Round 2 tính đúng binding factor
          session.nonces[n.role] = (n.nonceR2_x && n.nonceR2_y)
            ? { R_x: n.nonceR_x, R_y: n.nonceR_y, R1_x: n.nonceR_x, R1_y: n.nonceR_y, R2_x: n.nonceR2_x, R2_y: n.nonceR2_y }
            : { R_x: n.nonceR_x, R_y: n.nonceR_y };
        });

        const roles = Object.keys(session.nonces);
        session.signingBitmap = calculateSignerBitmap(roles);

        if (roles.length >= 5) {
          const validation = validateSignerBitmap(session.signingBitmap, roles, activeAction, session.isDisputeResolution);
          if (validation.valid) {
            try {
              const signingPubKeys = await resolveSigningPubKeys(escrowId, session);
              const pkAgg = aggregatePubKeysWithLagrange(signingPubKeys, roles, ROLE_TO_ID);

              const vaultAddr = escrowDb.contractAddress || session.contractAddress;
              if (vaultAddr) {
                const vaultKey = await getVaultAggregateKey(vaultAddr);
                assertSignerSetMatchesVault(pkAgg, vaultKey.pkAgg, roles);

                session.round2Context = computeRound2Context(session, activeAction, roles, pkAgg, vaultKey, vaultAddr);
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

  // A (0,0) key on-chain means the vault was never properly initialised OR the RPC call
  // silently returned zero. Either way, signing with a mismatched pkAgg is cryptographically
  // unsound — _verifySchnorr will always fail. Throw explicitly so callers know the state.
  if (deployedKeyIsUnset) {
    const error = new Error(
      'Vault aggregate key is (0, 0). The vault contract may not have been deployed with a valid ' +
      'aggregate key, or the RPC call to read pkAggX/pkAggY returned zero. ' +
      'Verify the vault deployment and retry.'
    );
    error.statusCode = 503;
    throw error;
  }

  if (samePkAgg(pkAgg, deployedPkAgg)) return;

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

/**
 * Suy ra signing public keys (Pⱼ) của tất cả parties từ Feldman commitments công khai.
 *
 *   Pⱼ = Σᵢ Σₖ Cᵢₖ · jᵏ   (không cần secret/shares)
 *
 * Đây là nguồn chân lý cho khóa ký dùng trong Lagrange aggregation, đảm bảo
 * Σ λⱼ·Pⱼ = master key (= Σ Cᵢ₀) — luôn khớp vault theo kiến trúc.
 *
 * @returns {Promise<{ [role: string]: string } | null>} map role → "0x04<x><y>", hoặc null nếu chưa đủ 7 commitments
 */
async function deriveSigningPubKeys(escrowId) {
  const commitmentRows = await prisma.dkgCommitment.findMany({ where: { escrowId } });
  if (!commitmentRows || commitmentRows.length < 7) return null;

  const { computeSigningPublicKeyFromCommitments } = await import('../crypto/pedersen-vss.js');

  // Parse commitments theo role để đảm bảo thứ tự nhất quán
  const commitmentsByRole = {};
  for (const row of commitmentRows) {
    commitmentsByRole[row.role] = JSON.parse(row.commitments);
  }

  const allCommitments = PARTICIPANT_ROLES.map(role => commitmentsByRole[role]).filter(Boolean);
  if (allCommitments.length < 7) return null;

  const signingPubKeys = {};
  for (const role of PARTICIPANT_ROLES) {
    const id = ROLE_TO_ID[role];
    const P = computeSigningPublicKeyFromCommitments(allCommitments, id);
    const x = P.x.replace(/^0x/i, '').padStart(64, '0');
    const y = P.y.replace(/^0x/i, '').padStart(64, '0');
    signingPubKeys[role] = `0x04${x}${y}`;
  }
  return signingPubKeys;
}

/**
 * Lấy signing pubkeys cho aggregation, ưu tiên khóa suy ra từ commitments (chuẩn DKG).
 * Cache trên session để tránh đọc DB lặp. Fallback về session.pubKeys cho escrow cũ
 * (chưa dùng DKG commitments).
 */
async function resolveSigningPubKeys(escrowId, session) {
  if (session?.signingPubKeys) return session.signingPubKeys;
  const derived = await deriveSigningPubKeys(escrowId);
  if (derived && session) session.signingPubKeys = derived;
  return derived || session?.pubKeys;
}

/**
 * Tính round2Context cho Round 2 — xử lý CẢ FROST (dual-nonce + binding factor) lẫn legacy.
 * Dùng chung cho mọi đường dẫn hoàn tất Round 1 (main, idempotent, recovery) để đảm bảo
 * round2Context LUÔN có bindingFactors khi nonces ở chế độ FROST. Thiếu binding factor sẽ
 * khiến frontend rơi về legacy z-share và không tìm thấy nonce → "Round 1 nonce not found".
 */
function computeRound2Context(session, action, roles, pkAgg, vaultKey, vaultAddr) {
  const frostEnabled = roles.every(r => session.nonces[r]?.R2_x && session.nonces[r]?.R2_y);
  const msgHash = buildMsgHash(vaultKey.trueChainEscrowId, action, session.signingBitmap, vaultAddr, vaultKey.chainId);

  let noncesForAggregation = session.nonces;
  let bindingFactors = null;
  if (frostEnabled) {
    const r1Points = Object.fromEntries(roles.map(r => [r, { R1_x: session.nonces[r].R1_x, R1_y: session.nonces[r].R1_y }]));
    const r2Points = Object.fromEntries(roles.map(r => [r, { R2_x: session.nonces[r].R2_x, R2_y: session.nonces[r].R2_y }]));
    bindingFactors = computeBindingFactors(roles, msgHash, r1Points, r2Points, ROLE_TO_ID);
    noncesForAggregation = computeEffectiveNonces(r1Points, r2Points, bindingFactors);
  }

  const { R_x, R_y, R_addr } = aggregateNoncesWithLagrange(noncesForAggregation, ROLE_TO_ID);
  const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);

  // Lưu effective nonce R_eff per-role để /sign verify từng z-share riêng lẻ.
  const effectiveNonces = {};
  for (const r of roles) effectiveNonces[r] = { R_x: noncesForAggregation[r].R_x, R_y: noncesForAggregation[r].R_y };

  return { R_x, R_y, R_addr, pkAgg, msgHash, challenge, signerBitmap: session.signingBitmap, bindingFactors, frostEnabled, effectiveNonces };
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
  if (pubKeyPersistenceDisabled || !prisma?.pubKeySubmission) return { status: 'skipped' };
  try {
    const existing = prisma.pubKeySubmission.findUnique
      ? await prisma.pubKeySubmission.findUnique({ where: { escrowId_role: { escrowId, role } }, select: { pubKey: true } })
      : null;
    if (existing?.pubKey) {
      const existingNorm = ('0x' + normalizePubKey(existing.pubKey)).toLowerCase();
      const incomingNorm = ('0x' + normalizePubKey(pubKey)).toLowerCase();
      if (existingNorm === incomingNorm) return { status: 'idempotent' };
    }
    if (prisma.pubKeySubmission.upsert) {
      await prisma.pubKeySubmission.upsert({
        where: { escrowId_role: { escrowId, role } },
        create: { escrowId, role, pubKey },
        update: { pubKey },
      });
    } else {
      await prisma.pubKeySubmission.create({ data: { escrowId, role, pubKey } });
    }
    return existing ? { status: 'updated' } : { status: 'created' };
  } catch (error) {
    if (isMissingTableError(error)) { pubKeyPersistenceDisabled = true; return { status: 'skipped' }; }
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

// Helper: Validate signerBitmap
// isDisputeResolution=true relaxes core-role check to AT LEAST ONE (mirrors contract logic)
// because dispute may exclude the losing party from the signer set
function validateSignerBitmap(bitmap, submittedRoles, action, isDisputeResolution = false) {
  const ALLOWED_BITS_MASK = 0x7f; // bits 0..6 only
  const CORE_ROLE_MASK = 0x03; // buyer (bit0) | seller (bit1)
  const MIN_SIGNERS = 5;

  const b = Number(bitmap);
  if (!Number.isFinite(b)) return { valid: false, error: 'Invalid bitmap' };
  if ((b & ~ALLOWED_BITS_MASK) !== 0) return { valid: false, error: 'Bitmap contains invalid bits' };

  // Count set bits using Kernighan's method (same idea as Solidity)
  let temp = b;
  let count = 0;
  while (temp) { temp &= temp - 1; count++; }

  if (count < MIN_SIGNERS) return { valid: false, error: `Need at least ${MIN_SIGNERS} signers, got ${count}` };

  if (action === 'release' || action === 'split') {
    if (isDisputeResolution) {
      // Dispute path: contract only requires at least one core role
      if ((b & CORE_ROLE_MASK) === 0) {
        return { valid: false, error: `Action '${action}' requires at least one core party (buyer or seller)` };
      }
    } else {
      // Happy path: both buyer and seller must approve
      if ((b & CORE_ROLE_MASK) !== CORE_ROLE_MASK) {
        return { valid: false, error: `Action '${action}' requires both buyer and seller to approve` };
      }
    }
  }

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
    // DKG flow: bypass expiry when all 7 parties have committed (Feldman VSS is the
    // authorization, not the old time-based window). Old non-DKG escrows still expire normally.
    const dkgCount = await prisma.dkgCommitment.count({ where: { escrowId } });
    const dkgComplete = dkgCount >= 7;
    const summaryBefore = getPubKeyCollectionSummary(session);
    if (summaryBefore.expired && !dkgComplete) {
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

      // Allow DKG signing key to replace identity pubkey even after vault deploy.
      // Vault pkAgg is derived from Feldman commitments (Σ Cᵢ₀), not from pubkey submissions,
      // so signing keys can legitimately be submitted after the vault is deployed.
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
    const { escrowId, role, action, signerBitmap, R_x, R_y, R2_x, R2_y } = req.body;
    if (!escrowId || !role || !action || signerBitmap === undefined || !R_x || !R_y) return res.status(400).json({ error: 'Missing required fields' });
    const isFrostMode = Boolean(R2_x && R2_y);
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role` });

    const session = await checkSession(escrowId, res);
    if (!session) return;

    const expectedAddress = getRoleAddress(session.participants || session.parties, role);
    if (normalizeAddress(req.user?.walletAddress) !== expectedAddress) return res.status(403).json({ error: `Auth mismatch for role '${role}'` });

    // Derive signing pubkeys from DKG commitments if not already in session.
    // Eliminates need for parties to submit pubkeys separately after DKG.
    if (!getPubKeyCollectionSummary(session).complete) {
      const derived = await deriveSigningPubKeys(escrowId);
      if (!derived) return res.status(409).json({ error: 'DKG chưa hoàn tất (cần đủ 7 commitments).' });
      session.pubKeys = { ...derived, ...session.pubKeys };
      session.pubKeyCollectionState = 'COMPLETE';
      await saveSession(escrowId, session);
    }

    const { allowedRoles, isDisputeResolution } = await getAllowedSignerRoles(escrowId);
    if (!allowedRoles.includes(role)) return res.status(403).json({ error: `Role '${role}' is not allowed to sign according to the dispute outcome.` });

    const bitmap = Number(signerBitmap);
    if (!session.signingAction) {
      session.signingAction = action; session.nonces = {}; session.zShares = {}; session.signingBitmap = 0; session.signingStartedAt = Date.now();
      // Cache dispute flag so all subsequent callsites use same value without extra DB query
      session.isDisputeResolution = isDisputeResolution;
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

    let normalizedRx, normalizedRy, normalizedR2x, normalizedR2y;
    try {
      normalizedRx = normalizeCoordinate(R_x); normalizedRy = normalizeCoordinate(R_y);
      if (isFrostMode) { normalizedR2x = normalizeCoordinate(R2_x); normalizedR2y = normalizeCoordinate(R2_y); }
    } catch (e) { return res.status(400).json({ error: 'Invalid coordinate format' }); }

    // Check if nonce already exists for this role
    if (session.nonces[role]) {
      const existingRx = session.nonces[role].R_x;
      const existingRy = session.nonces[role].R_y;

      // Same nonce value - idempotent submission
      const existingR2x = session.nonces[role].R2_x;
      const existingR2y = session.nonces[role].R2_y;
      const r2Match = !isFrostMode || (existingR2x === normalizedR2x && existingR2y === normalizedR2y);
      if (existingRx === normalizedRx && existingRy === normalizedRy && r2Match) {
        const nonceCount = Object.keys(session.nonces).length;
        console.log(`[Nonce] Idempotent submission from role '${role}' for escrow ${escrowId}`);

        // Recalculate signerBitmap based on actual submitted roles
        const submittedRoles = Object.keys(session.nonces);
        session.signingBitmap = calculateSignerBitmap(submittedRoles);

        // If Round 1 is complete, return the round2Context.
        // Self-heal: nếu context cũ thiếu bindingFactors trong khi nonces là FROST → tính lại.
        if (session.round2Context) {
          const ctxRoles = Object.keys(session.nonces);
          const noncesAreFrost = ctxRoles.every(r => session.nonces[r]?.R2_x && session.nonces[r]?.R2_y);
          const ctxMissingBinding = noncesAreFrost && !session.round2Context.bindingFactors;
          if (ctxMissingBinding && nonceCount >= 5) {
            try {
              const dbEscrowHeal = await prisma.escrow.findUnique({ where: { id: escrowId } });
              const vaultAddrHeal = dbEscrowHeal?.contractAddress || session.contractAddress;
              const signingPubKeysHeal = await resolveSigningPubKeys(escrowId, session);
              const pkAggHeal = aggregatePubKeysWithLagrange(signingPubKeysHeal, ctxRoles, ROLE_TO_ID);
              const vaultKeyHeal = await getVaultAggregateKey(vaultAddrHeal);
              assertSignerSetMatchesVault(pkAggHeal, vaultKeyHeal.pkAgg, ctxRoles);
              session.round2Context = computeRound2Context(session, action, ctxRoles, pkAggHeal, vaultKeyHeal, vaultAddrHeal);
              await saveSession(escrowId, session);
              console.log(`[Nonce] Self-healed stale round2Context with FROST binding factors for escrow ${escrowId}`);
            } catch (healErr) {
              console.warn(`[Nonce] Could not self-heal round2Context: ${healErr.message}`);
            }
          }
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
          const validation = validateSignerBitmap(session.signingBitmap, roles, action, session.isDisputeResolution);
          if (validation.valid) {
            try {
              const dbEscrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
              const vaultAddr = dbEscrow?.contractAddress || session.contractAddress;
              const signingPubKeys = await resolveSigningPubKeys(escrowId, session);
              const pkAgg = aggregatePubKeysWithLagrange(signingPubKeys, roles, ROLE_TO_ID);
              const vaultKey = await getVaultAggregateKey(vaultAddr);
              assertSignerSetMatchesVault(pkAgg, vaultKey.pkAgg, roles);

              session.round2Context = computeRound2Context(session, action, roles, pkAgg, vaultKey, vaultAddr);
              session.signingRoles = roles;
              await saveSession(escrowId, session);

              console.log(`[Nonce] Auto-computed challenge on idempotent submission: R_addr=${session.round2Context.R_addr}, FROST=${session.round2Context.frostEnabled}`);

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

      // Different nonce value.
      // QUAN TRỌNG: nếu Round 1 ĐÃ hoàn tất (round2Context locked) → KHÔNG cho đổi nonce,
      // trả round2_ready để party đi tiếp Round 2. Aggregate R/challenge đã chốt; đổi nonce
      // lúc này sẽ đổi challenge và làm hỏng các z-share đã/đang ký → InvalidSignature.
      // KHÔNG trả existingNonce ở đây để frontend không hiểu nhầm là cần reset.
      if (session.round2Context) {
        console.warn(`[Nonce] Role '${role}' submitted new nonce but Round 1 is locked. Returning round2_ready (ignore new nonce).`);
        return res.json({
          state: 'round2_ready',
          received: Object.keys(session.nonces).length,
          needed: 5,
          submittedRoles: Object.keys(session.nonces),
          round2Context: session.round2Context,
          signerBitmap: session.signingBitmap,
          message: 'Round 1 already complete. Proceed to Round 2 with the locked challenge.'
        });
      }

      // Round 1 CHƯA hoàn tất → cho phép GHI ĐÈ nonce mới nhất của party (an toàn vì chưa
      // aggregate). Cho phép party đã mất nonce cục bộ submit lại nonce mới mà không phải reset.
      console.log(`[Nonce] Overwriting in-progress nonce for role '${role}' (Round 1 not yet complete).`);
    }

    session.nonces[role] = isFrostMode
      ? { R_x: normalizedRx, R_y: normalizedRy, R1_x: normalizedRx, R1_y: normalizedRy, R2_x: normalizedR2x, R2_y: normalizedR2y }
      : { R_x: normalizedRx, R_y: normalizedRy };

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
          ...(isFrostMode && { nonceR2_x: normalizedR2x, nonceR2_y: normalizedR2y }),
          expiresAt: new Date(Date.now() + nonceTTL)
        },
        create: {
          escrowId,
          action,
          role,
          nonceR_x: normalizedRx,
          nonceR_y: normalizedRy,
          ...(isFrostMode && { nonceR2_x: normalizedR2x, nonceR2_y: normalizedR2y }),
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
    const validation = validateSignerBitmap(session.signingBitmap, roles, action, session.isDisputeResolution);
    if (!validation.valid) return res.status(403).json({ error: validation.error });
    session.signingRoles = roles;

    const signingPubKeys = await resolveSigningPubKeys(escrowId, session);
    const pkAgg = aggregatePubKeysWithLagrange(signingPubKeys, roles, ROLE_TO_ID);

    // VÁ LỖI: Lấy Vault thật chuẩn xác để băm chữ ký
    const dbEscrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
    const vaultAddr = dbEscrow?.contractAddress || session.contractAddress;
    const vaultKey = await getVaultAggregateKey(vaultAddr);
    assertSignerSetMatchesVault(pkAgg, vaultKey.pkAgg, roles);

    // Tính round2Context (FROST-aware) — dùng helper dùng chung
    session.round2Context = computeRound2Context(session, action, roles, pkAgg, vaultKey, vaultAddr);
    const { R_addr, challenge, msgHash, bindingFactors, frostEnabled } = session.round2Context;

    console.log(`[TSS Round 2] Escrow: ${escrowId}, FROST: ${frostEnabled}`);
    console.log(`[TSS Round 2] Action: ${action}, Bitmap: ${session.signingBitmap}`);
    console.log(`[TSS Round 2] Vault: ${vaultAddr}, ChainId: ${vaultKey.chainId}`);
    console.log(`[TSS Round 2] msgHash: ${msgHash}`);
    console.log(`[TSS Round 2] R_addr: ${R_addr}, challenge (e): ${challenge}`);

    await saveSession(escrowId, session);

    if (io) {
      io.to(escrowId).emit('nonce_collected', { escrowId, R_addr, challenge, msgHash, pkAgg, signerBitmap: session.signingBitmap, bindingFactors, frostEnabled });
    }

    return res.json({ ok: true, R_addr, challenge, msgHash, pkAgg, signerBitmap: session.signingBitmap, bindingFactors, frostEnabled });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.message.includes('bad point')) return res.status(400).json({ error: 'Invalid point coordinates' });
    res.status(500).json({ error: error.message });
  }
});

// ─── Phase 2: Threshold Signing — Round 2 (z share submission) ───────────────
router.post('/sign', authMiddleware, escrowSignRateLimiter, async (req, res) => {
  try {
    const { escrowId, role, signerBitmap, z, challenge: submittedChallenge } = req.body;
    if (!escrowId || !role || signerBitmap === undefined || !z) return res.status(400).json({ error: 'Missing required fields' });

    const session = await checkSession(escrowId, res);
    if (!session || !session.round2Context) return res.status(400).json({ error: 'Round 1 not completed' });
    if (!session.signingRoles?.includes(role)) return res.status(403).json({ error: `Role '${role}' did not participate in Round 1` });

    // Check signing timeout (6 hours)
    if (isSigningExpired(session)) {
      return res.status(410).json({ error: 'Signing session expired. Please restart signing.' });
    }

    // CHỐNG TRỘN CHALLENGE: nếu frontend gửi kèm challenge mà nó dùng để tính z, phải khớp
    // challenge hiện tại của session. Lệch nghĩa là z tính trên Round 1 cũ (đã bị reset/đổi)
    // → từ chối để tránh aggregate trộn challenge → InvalidSignature on-chain.
    if (submittedChallenge) {
      const cur = String(session.round2Context.challenge || '').toLowerCase();
      const got = String(submittedChallenge).toLowerCase();
      if (cur && got && cur !== got) {
        return res.status(409).json({
          error: 'Stale challenge: your Z-Share was computed against an outdated Round 1. Refresh and recompute Round 2.',
          currentChallenge: session.round2Context.challenge
        });
      }
    }

    // VERIFY z-share riêng lẻ: zᵢ·G == R_effᵢ + e·Pᵢ.
    // Bắt ngay party có private key sⱼ KHÔNG khớp Pⱼ (vd: key cũ từ DKG run trước) →
    // tránh aggregate ra chữ ký hỏng và InvalidSignature mơ hồ on-chain.
    try {
      const rEff = session.round2Context.effectiveNonces?.[role];
      const signingPubKeysForVerify = await resolveSigningPubKeys(escrowId, session);
      const myPubKey = signingPubKeysForVerify?.[role];
      if (rEff && myPubKey) {
        const ok = verifyZShare(z, rEff, session.round2Context.challenge, myPubKey);
        if (!ok) {
          return res.status(400).json({
            error: `Z-Share của role '${role}' không hợp lệ: private signing key không khớp với khóa công khai suy ra từ DKG commitments. ` +
                   `Có thể bạn đang dùng key cũ từ lần DKG trước — hãy chạy lại DKG (Reset DKG) để đồng bộ, hoặc khôi phục đúng signing key.`
          });
        }
      } else {
        console.warn(`[Sign] Skip per-share verify for '${role}': missing effectiveNonces or pubkey.`);
      }
    } catch (verifyErr) {
      console.warn(`[Sign] Per-share verify error for '${role}': ${verifyErr.message}`);
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
    const validation = validateSignerBitmap(submittedBitmap, session.signingRoles, session.signingAction, session.isDisputeResolution);
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

  if (!req.query.roles) {
    return res.status(400).json({ error: 'roles query parameter is required' });
  }

  const targetRoles = req.query.roles.split(',').map(r => r.trim());

  try {
    const signingPubKeys = await resolveSigningPubKeys(req.params.id, session);
    const pkAgg = aggregatePubKeysWithLagrange(signingPubKeys, targetRoles, ROLE_TO_ID);
    return res.json({
      ok: true,
      pkAgg: pkAgg,
      pkAggCoords: [pkAgg.x, pkAgg.y]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ─── DKG (Pedersen VSS) Routes ───────────────────────────────────────────────

/**
 * POST /escrow/:id/dkg/commitment
 * Party i broadcast Feldman commitments: [{x,y} * 5]
 * Body: { role, commitments: [{x,y}*5], pubKeyHex }
 * pubKeyHex là identity public key của party — dùng để các party khác mã hóa shares gửi đến party này
 */
router.post('/:id/dkg/commitment', authMiddleware, async (req, res) => {
  const { id: escrowId } = req.params;
  const { role, commitments, pubKeyHex } = req.body;

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (!Array.isArray(commitments) || commitments.length !== 5) {
    return res.status(400).json({ error: 'commitments must be array of 5 EC points' });
  }
  if (!pubKeyHex) {
    return res.status(400).json({ error: 'pubKeyHex is required' });
  }

  try {
    // Guard: reject identity pubkey change mid-DKG — other parties may have already
    // encrypted shares using the old pubkey; allowing a swap would cause OperationError in B3.
    const existingCommitment = await prisma.dkgCommitment.findUnique({
      where: { escrowId_role: { escrowId, role } }
    });
    if (existingCommitment?.identityPubKey && existingCommitment.identityPubKey !== pubKeyHex) {
      return res.status(409).json({
        error: `pubkey mismatch: party '${role}' already registered a different pubkey. Run DKG Reset first.`,
        code: 'DKG_PUBKEY_MISMATCH'
      });
    }

    // Upsert commitment + identity pubkey together. Identity pubkey lives on this row
    // (not PubKeySubmission) so /pubkey/submit's later signing-pubkey write can't clobber it.
    await prisma.dkgCommitment.upsert({
      where: { escrowId_role: { escrowId, role } },
      create: { escrowId, role, commitments: JSON.stringify(commitments), identityPubKey: pubKeyHex },
      update: { commitments: JSON.stringify(commitments), identityPubKey: pubKeyHex }
    });

    // Đếm xem đã có bao nhiêu commitments
    const count = await prisma.dkgCommitment.count({ where: { escrowId } });

    // Emit progress event
    emitToEscrow(escrowId, 'dkg:commitment', { role, total: count, required: 7 });

    res.json({ ok: true, role, total: count, required: 7 });
  } catch (error) {
    console.error('[DKG/commitment]', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /escrow/:id/dkg/share
 * Party i gửi encrypted shares cho tất cả parties khác (6 shares mỗi lần call)
 * Body: { fromRole, shares: [{ toRole, encryptedBlob }] }
 */
router.post('/:id/dkg/share', authMiddleware, async (req, res) => {
  const { id: escrowId } = req.params;
  const { fromRole, shares } = req.body;

  if (!fromRole || !VALID_ROLES.includes(fromRole)) {
    return res.status(400).json({ error: 'Invalid fromRole' });
  }
  if (!Array.isArray(shares) || shares.length === 0) {
    return res.status(400).json({ error: 'shares array is required' });
  }

  // Validate mỗi share entry
  for (const s of shares) {
    if (!s.toRole || !VALID_ROLES.includes(s.toRole)) {
      return res.status(400).json({ error: `Invalid toRole: ${s.toRole}` });
    }
    if (!s.encryptedBlob) {
      return res.status(400).json({ error: `Missing encryptedBlob for toRole: ${s.toRole}` });
    }
  }

  try {
    // Upsert tất cả shares trong transaction
    await prisma.$transaction(
      shares.map(s =>
        prisma.dkgShare.upsert({
          where: { escrowId_fromRole_toRole: { escrowId, fromRole, toRole: s.toRole } },
          create: { escrowId, fromRole, toRole: s.toRole, encryptedBlob: s.encryptedBlob },
          update: { encryptedBlob: s.encryptedBlob }
        })
      )
    );

    // Đếm total shares đã submit
    const totalShares = await prisma.dkgShare.count({ where: { escrowId } });

    emitToEscrow(escrowId, 'dkg:shares', { fromRole, totalShares });

    res.json({ ok: true, fromRole, submitted: shares.length, totalShares });
  } catch (error) {
    console.error('[DKG/share]', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /escrow/:id/dkg/shares?toRole=xxx
 * Party j fetch tất cả encrypted shares được gửi đến mình (6 shares từ 6 parties khác)
 * Đồng thời trả về commitments của tất cả parties (để Feldman verify)
 */
router.get('/:id/dkg/shares', authMiddleware, async (req, res) => {
  const { id: escrowId } = req.params;
  const { toRole } = req.query;

  if (!toRole || !VALID_ROLES.includes(toRole)) {
    return res.status(400).json({ error: 'toRole query parameter is required and must be valid' });
  }

  try {
    // Fetch shares gửi đến party này
    const shares = await prisma.dkgShare.findMany({
      where: { escrowId, toRole }
    });

    // Fetch tất cả commitments (cần để Feldman verify) + identity pubkeys (cần để ECDH decrypt).
    // Identity pubkeys live on the DkgCommitment row, so /pubkey/submit's signing-pubkey
    // write cannot overwrite them mid-DKG (root cause of the prior B3 OperationError).
    const commitments = await prisma.dkgCommitment.findMany({
      where: { escrowId }
    });

    const commitmentsMap = Object.fromEntries(
      commitments.map(c => [c.role, JSON.parse(c.commitments)])
    );
    const pubKeysMap = Object.fromEntries(
      commitments.filter(c => c.identityPubKey).map(c => [c.role, c.identityPubKey])
    );

    res.json({
      ok: true,
      toRole,
      shares: shares.map(s => ({ fromRole: s.fromRole, encryptedBlob: s.encryptedBlob })),
      commitments: commitmentsMap,
      pubKeys: pubKeysMap,
      sharesReady: shares.length,
      sharesRequired: 7  // cần nhận từ 7 parties (6 khác + 1 self)
    });
  } catch (error) {
    console.error('[DKG/shares]', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /escrow/:id/dkg/master-pubkey
 * Tính master public key P = Σ Cᵢ₀ từ tất cả Feldman commitments
 * Dùng để deploy EscrowVault (thay thế aggregate-key cũ)
 * Chỉ khả dụng khi đủ 7 commitments
 */
router.get('/:id/dkg/master-pubkey', async (req, res) => {
  const { id: escrowId } = req.params;

  try {
    const commitments = await prisma.dkgCommitment.findMany({
      where: { escrowId }
    });

    if (commitments.length < 7) {
      return res.status(400).json({
        error: `DKG incomplete: ${commitments.length}/7 commitments received`,
        received: commitments.length,
        required: 7
      });
    }

    // Tính P = Σ Cᵢ₀ (sum constant-term commitments)
    const { computeMasterPublicKey } = await import('../crypto/pedersen-vss.js');
    const allCommitments = commitments.map(c => JSON.parse(c.commitments));
    const masterPubKey = computeMasterPublicKey(allCommitments);

    res.json({
      ok: true,
      masterPubKey,
      commitmentCount: commitments.length
    });
  } catch (error) {
    console.error('[DKG/master-pubkey]', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/status', async (req, res) => {
  const escrowId = req.params.id;
  const session = await checkSession(escrowId, res);
  if (!session) return;
  // Báo frontend biết đang ở phase nào của signing để khôi phục UI sau khi re-login.
  // round2_ready: Round 1 đã chốt, có round2Context → FE hiển thị nút Z-Share ngay.
  const signingState = session.round2Context ? 'round2_ready' : (session.signingAction ? 'round1_in_progress' : 'idle');
  // dkgCommitmentCount: số parties đã hoàn thành DKG B1 (0-7). Gate signing/dispute
  // bằng giá trị này thay vì pubkeyCollection.received (đã không còn được submit sau refactor).
  const dkgCommitmentCount = await prisma.dkgCommitment.count({ where: { escrowId } });
  res.json({
    status: session.status, signingAction: session.signingAction, signerBitmap: session.signingBitmap,
    nonceCount: Object.keys(session.nonces).length, zShareCount: Object.keys(session.zShares).length,
    completedActions: session.completedActions, pubkeyCollection: toCollectionPayload(getPubKeyCollectionStatus(session)),
    signingState,
    round2Context: session.round2Context || null,
    dkgCommitmentCount,
    dkgReady: dkgCommitmentCount >= 7
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

    // Validate bitmap (approvals endpoint is read-only, no session available; use DB dispute check)
    const { isDisputeResolution: approvalDisputeFlag } = await getAllowedSignerRoles(escrowId);
    const validation = validateSignerBitmap(expectedBitmap, approvedRoles, action, approvalDisputeFlag);

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

// ─── Reset DKG State ──────────────────────────────────────────────────────────
// Clears DkgCommitment, DkgShare, PubKeySubmission so all parties can re-run DKG.
// Use when vault key doesn't match signing keys (e.g. vault deployed before DKG completed).
router.post('/:id/dkg/reset', authMiddleware, async (req, res) => {
  try {
    const { id: escrowId } = req.params;
    if (!escrowId) return res.status(400).json({ error: 'Missing escrowId' });

    // Delete all DKG-related DB rows for this escrow
    const [delCommitments, delShares, delPubKeys] = await Promise.allSettled([
      prisma.dkgCommitment.deleteMany({ where: { escrowId } }),
      prisma.dkgShare.deleteMany({ where: { escrowId } }),
      prisma.pubKeySubmission.deleteMany({ where: { escrowId } }),
    ]);

    console.log(`[ResetDKG] escrow=${escrowId} commitments=${delCommitments.value?.count ?? 'err'} shares=${delShares.value?.count ?? 'err'} pubkeys=${delPubKeys.value?.count ?? 'err'}`);

    // Reset session state so pubkey collection starts fresh
    let session = await getSession(escrowId);
    if (session) {
      session.pubKeys = {};
      session.signingPubKeys = null;
      session.pubKeyCollectionState = 'PARTIAL';
      session.pubKeyCollectionDueAt = null;
      session.precomputedPkAgg = null;
      session.nonces = {};
      session.zShares = {};
      session.signingRoles = null;
      session.signingAction = null;
      session.round2Context = null;
      await saveSession(escrowId, session);
    }

    // Notify all connected clients that DKG was reset
    const io = req.app.get('io');
    if (io) {
      io.to(escrowId).emit('dkg_reset', {
        escrowId,
        message: 'DKG state has been reset. All parties must re-run DKG.',
      });
    }

    res.json({ ok: true, message: 'DKG state reset successfully. All parties must re-run DKG.', escrowId });
  } catch (error) {
    console.error('[ResetDKG] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

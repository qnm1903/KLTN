import express from 'express';
import { deleteSession, getSession, hasSession, saveSession } from '../store/session.js';
import {
  getActionSigners,
  getPkAggForRoles,
  initDKG,
  SESSION_TTL_MS
} from '../crypto/dkg.js';
import { aggregateNonces, computeChallenge, aggregateZShares } from '../crypto/schnorr.js';
import { ethers } from 'ethers';
import { createRouteRateLimiter, getRateLimitConfig } from '../middleware/rate-limit.js';

const router = express.Router();
const { escrowInitMax, escrowSignMax } = getRateLimitConfig();

const escrowInitRateLimiter = createRouteRateLimiter({
  max: escrowInitMax,
  message: 'Too many escrow init requests. Please try again later.'
});

const escrowSignRateLimiter = createRouteRateLimiter({
  max: escrowSignMax,
  message: 'Too many escrow sign requests. Please try again later.'
});

const VALID_ROLES = ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5'];
const VALID_ACTIONS = ['release', 'refund', 'timeout'];

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

    if (!escrowId || !chainId || !contractAddress || !buyerAddr || !sellerAddr ||
        !Array.isArray(mediatorAddrs) || mediatorAddrs.length !== 5 ||
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

    if (await hasSession(escrowId)) {
      return res.status(409).json({ error: 'Session already exists for this escrowId' });
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
      contractAddress,
      chainId
    });

    session.parties = {
      buyer: buyerAddr.toLowerCase(),
      seller: sellerAddr.toLowerCase(),
      mediators: mediatorAddrs.map((address) => address.toLowerCase())
    };
    await saveSession(escrowId, session);

    res.json({ ok: true, contractAddress, chainId });
  } catch (error) {
    console.error('Error in /init:', error.message);
    if (/public key/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
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
router.post('/nonce', async (req, res) => {
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
router.post('/sign', escrowSignRateLimiter, async (req, res) => {
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

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/:id/status', async (req, res) => {
  const session = await checkSession(req.params.id, res);
  if (!session) return;
  res.json({
    status: session.status,
    signingAction: session.signingAction,
    signerBitmap: session.signingBitmap,
    nonceCount: Object.keys(session.nonces).length,
    zShareCount: Object.keys(session.zShares).length,
    parties: session.parties,
    completedActions: session.completedActions
  });
});

export default router;
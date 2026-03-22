import express from 'express';
import { sessions } from '../store/session.js';
import { initDKG, getPkAggForRoles, SESSION_TTL_MS } from '../crypto/dkg.js';
import { aggregateNonces, computeChallenge, aggregateZShares } from '../crypto/schnorr.js';
import { ethers } from 'ethers';

const router = express.Router();

const VALID_ROLES = ['buyer', 'seller', 'mediator'];
const VALID_ACTIONS = ['release', 'refund', 'timeout'];
const ACTION_ROLE_PAIRS = {
  release: ['buyer', 'seller'],
  refund: ['buyer', 'mediator'],
  timeout: ['seller', 'mediator']
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkSession(escrowId, res) {
  const session = sessions.get(escrowId);
  if (!session) { res.status(404).json({ error: 'Escrow session not found' }); return null; }
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(escrowId);
    res.status(410).json({ error: 'Session expired' });
    return null;
  }
  return session;
}

function buildMsgHash(escrowId, action) {
  const id = escrowId.startsWith('0x') ? escrowId : ethers.id(escrowId);
  return ethers.solidityPackedKeccak256(['bytes32', 'string'], [id, action]);
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

function roleIsAllowedForAction(role, action) {
  return ACTION_ROLE_PAIRS[action].includes(role);
}

function rolesMatchAction(roles, action) {
  const expected = [...ACTION_ROLE_PAIRS[action]].sort().join('+');
  const actual = [...roles].sort().join('+');
  return expected === actual;
}

// ─── Phase 1: DKG ─────────────────────────────────────────────────────────────

/**
 * POST /api/escrow/init
 * Frontend gửi 3 public keys (mỗi bên tự sinh s_i ở thiết bị của mình).
 * Backend chỉ tổng hợp PKagg pairs — không sinh hoặc biết private key nào.
 * Trả về 3 PKagg pairs để frontend đưa vào lúc tạo EscrowVault.
 */
router.post('/init', (req, res) => {
  try {
    const { escrowId, buyerAddr, sellerAddr, mediatorAddr,
            buyerPubKey, sellerPubKey, mediatorPubKey } = req.body;

    if (!escrowId || !buyerAddr || !sellerAddr || !mediatorAddr ||
        !buyerPubKey || !sellerPubKey || !mediatorPubKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const derivedBuyer = ethers.computeAddress('0x' + normalizePubKey(buyerPubKey));
    const derivedSeller = ethers.computeAddress('0x' + normalizePubKey(sellerPubKey));
    const derivedMediator = ethers.computeAddress('0x' + normalizePubKey(mediatorPubKey));

    if (derivedBuyer.toLowerCase() !== buyerAddr.toLowerCase()) {
      return res.status(400).json({ error: 'buyerPubKey does not match buyerAddr' });
    }
    if (derivedSeller.toLowerCase() !== sellerAddr.toLowerCase()) {
      return res.status(400).json({ error: 'sellerPubKey does not match sellerAddr' });
    }
    if (derivedMediator.toLowerCase() !== mediatorAddr.toLowerCase()) {
      return res.status(400).json({ error: 'mediatorPubKey does not match mediatorAddr' });
    }

    if (sessions.has(escrowId)) {
      return res.status(409).json({ error: 'Session already exists for this escrowId' });
    }

    const result = initDKG(escrowId, { buyerPubKey, sellerPubKey, mediatorPubKey }, sessions);

    const session = sessions.get(escrowId);
    session.parties = {
      buyer: buyerAddr.toLowerCase(),
      seller: sellerAddr.toLowerCase(),
      mediator: mediatorAddr.toLowerCase()
    };
    sessions.set(escrowId, session);

    // Trả về 3 PKagg pairs để đưa vào constructor EscrowVault
    res.json(result);
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
router.post('/nonce', (req, res) => {
  try {
    const { escrowId, role, action, R_x, R_y } = req.body;

    if (!escrowId || !role || !action || !R_x || !R_y) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Allowed: ${VALID_ACTIONS.join(', ')}` });
    }
    if (!roleIsAllowedForAction(role, action)) {
      return res.status(403).json({ error: `Role '${role}' is not allowed for action '${action}'` });
    }

    const session = checkSession(escrowId, res);
    if (!session) return;

    if (session.completedActions.includes(action)) {
      return res.status(409).json({ error: `Action '${action}' already signed` });
    }

    // Khi round 1 bắt đầu, lock action và xác định 2 bên tham gia
    if (!session.signingAction) {
      session.signingAction = action;
      session.nonces = {};
      session.zShares = {};
    } else if (session.signingAction !== action) {
      return res.status(409).json({ error: 'Different action already in progress' });
    }

    // Verify role này có trong session
    if (!session.pubKeys[role]) {
      return res.status(403).json({ error: `Role '${role}' not found in this escrow` });
    }

    const nonceCountBefore = Object.keys(session.nonces).length;
    if (!session.nonces[role] && nonceCountBefore >= 2) {
      return res.status(409).json({ error: 'Nonce round already has 2 participants' });
    }

    session.nonces[role] = { R_x, R_y };
    sessions.set(escrowId, session);

    const io = req.app.get('io');
    const nonceCount = Object.keys(session.nonces).length;

    if (nonceCount < 2) {
      if (io) io.to(escrowId).emit('nonce_received', { count: nonceCount, needed: 2 });
      return res.json({ received: nonceCount, needed: 2 });
    }

    // Đủ 2 nonces — tổng hợp R, tính PKagg và challenge e
    const roles = Object.keys(session.nonces);
    if (!rolesMatchAction(roles, action)) {
      session.nonces = {};
      session.zShares = {};
      session.signingRoles = null;
      session.signingAction = null;
      session.round2Context = null;
      sessions.set(escrowId, session);
      return res.status(403).json({ error: `Signer roles do not match action '${action}' requirements` });
    }
    session.signingRoles = roles;

    const pkAgg = getPkAggForRoles(session, roles);
    const { R_x: agg_Rx, R_y: agg_Ry, R_addr } = aggregateNonces(Object.values(session.nonces));

    const msgHash = buildMsgHash(escrowId, action);
    const challenge = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);

    // Lưu context cho round 2
    session.round2Context = { R_x: agg_Rx, R_y: agg_Ry, R_addr, pkAgg, msgHash, challenge };
    sessions.set(escrowId, session);

    // Broadcast challenge — mỗi bên dùng e để tính z_i = k_i + e * s_i
    if (io) {
      io.to(escrowId).emit('nonce_collected', { R_addr, challenge, msgHash, pkAgg });
    }

    return res.json({ ok: true, R_addr, challenge, msgHash, pkAgg });
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
router.post('/sign', (req, res) => {
  try {
    const { escrowId, role, z } = req.body;

    if (!escrowId || !role || !z) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${VALID_ROLES.join(', ')}` });
    }

    const session = checkSession(escrowId, res);
    if (!session) return;

    if (!session.round2Context) {
      return res.status(400).json({ error: 'Round 1 not completed. Submit nonces first.' });
    }
    if (!session.signingRoles.includes(role)) {
      return res.status(403).json({ error: `Role '${role}' is not part of current signing session` });
    }
    if (!roleIsAllowedForAction(role, session.signingAction)) {
      return res.status(403).json({ error: `Role '${role}' is not allowed for action '${session.signingAction}'` });
    }

    session.zShares[role] = z;
    sessions.set(escrowId, session);

    const io = req.app.get('io');
    const zCount = Object.keys(session.zShares).length;

    if (zCount < 2) {
      if (io) io.to(escrowId).emit('z_received', { count: zCount, needed: 2 });
      return res.json({ received: zCount, needed: 2 });
    }

    // Đủ 2 z shares — tổng hợp chữ ký cuối
    const { R_addr, pkAgg, msgHash, challenge: e } = session.round2Context;
    const z_agg = aggregateZShares(Object.values(session.zShares));

    // Đánh dấu action hoàn thành, dọn trạng thái signing
    session.completedActions.push(session.signingAction);
    session.nonces = {};
    session.zShares = {};
    session.signingRoles = null;
    session.signingAction = null;
    session.round2Context = null;
    sessions.set(escrowId, session);

    const sig = { R_addr, z: z_agg, e, msgHash };

    if (io) io.to(escrowId).emit('schnorr_complete', sig);

    return res.json(sig);
  } catch (error) {
    console.error('Error in /sign:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Status & Dispute ─────────────────────────────────────────────────────────

router.get('/:id/status', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Escrow session not found' });
  res.json({
    status: session.status,
    signingAction: session.signingAction,
    nonceCount: Object.keys(session.nonces).length,
    zShareCount: Object.keys(session.zShares).length,
    parties: session.parties,
    completedActions: session.completedActions
  });
});

router.post('/dispute', (req, res) => {
  const { escrowId } = req.body;
  const session = sessions.get(escrowId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.status = 'DISPUTED';
  sessions.set(escrowId, session);
  res.json({ ok: true });
});

export default router;
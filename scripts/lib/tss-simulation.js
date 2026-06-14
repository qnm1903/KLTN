/**
 * TSS Simulation Core — Pedersen VSS DKG + FROST Schnorr signing (in-process).
 *
 * Mô phỏng toàn bộ vòng đời mật mã TSS mà KHÔNG cần blockchain/DB/server, tái dùng
 * đúng các primitive trong backend (pedersen-vss.js + elliptic secp256k1).
 *
 * Dùng chung bởi:
 *   - experiment-tss-benchmark.js  (đo computation/communication theo từng phase)
 *   - experiment-throughput.js     (đo completion throughput + điểm bão hòa)
 */

import { performance } from 'perf_hooks';
import { randomBytes, createHash } from 'crypto';
import EC_Module from 'elliptic';
import {
  generatePolynomial,
  computeCommitments,
  evaluatePolynomial,
  verifyShare,
  aggregateShares,
  computeSigningPublicKeyFromCommitments,
  computeMasterPublicKey,
} from '../../backend/src/crypto/pedersen-vss.js';

export const ec = new EC_Module.ec('secp256k1');
export const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function randomScalar() {
  let s;
  do { s = BigInt('0x' + randomBytes(32).toString('hex')); }
  while (s === 0n || s >= ORDER);
  return s;
}

export function scalarToHex(s) { return '0x' + s.toString(16).padStart(64, '0'); }

export function generateRoles(n) {
  const roles = ['buyer', 'seller'];
  for (let i = 1; i <= n - 2; i++) roles.push(`mediator${i}`);
  return roles;
}

export function generateRoleToId(n) {
  const map = { buyer: 1, seller: 2 };
  for (let i = 1; i <= n - 2; i++) map[`mediator${i}`] = i + 2;
  return map;
}

export function estimateMsgBytes(obj) {
  return JSON.stringify(obj).length;
}

/**
 * BFT minimum threshold for n parties.
 * f = floor((n-1)/3) max Byzantine faults; t = 2f+1 minimum signers.
 */
export function bftMin(n) {
  const f = Math.floor((n - 1) / 3);
  return 2 * f + 1;
}

// ─── DKG Simulation (Pedersen/Feldman VSS) ──────────────────────────────────────

/**
 * Simulate full Pedersen VSS DKG for (t, n) config.
 * Returns per-phase metrics { B1..B4: { time_ms, msg_count, msg_bytes } } plus
 * internal `_`-prefixed fields (finalShares, signingPubKeys, roles, roleToId) for signing.
 */
export function runDKG(t, n) {
  const roles    = generateRoles(n);
  const roleToId = generateRoleToId(n);
  const metrics  = {};

  const polynomials = {};
  const commitments = {};
  const shares      = {};  // shares[fromRole][toRole] = shareHex
  const finalShares = {};

  // ── B1: Polynomial generation + Feldman commitments (n broadcasts) ──────────
  {
    const t0 = performance.now();
    let totalBytes = 0;
    for (const role of roles) {
      const { coeffs } = generatePolynomial(t);
      polynomials[role] = coeffs;
      const comms = computeCommitments(coeffs);
      commitments[role] = comms;
      totalBytes += estimateMsgBytes({ role, commitments: comms });
    }
    metrics.B1 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: n, msg_bytes: totalBytes };
  }

  // ── B2: Encrypted share distribution (n*(n-1) point-to-point) ───────────────
  {
    const t0 = performance.now();
    let msgCount = 0, totalBytes = 0;
    for (const fromRole of roles) {
      shares[fromRole] = {};
      for (const toRole of roles) {
        if (fromRole === toRole) continue;
        const share = evaluatePolynomial(polynomials[fromRole], roleToId[toRole]);
        shares[fromRole][toRole] = share;
        msgCount++;
        // Simulated ECDH-AES-GCM blob ~ iv(32)+share(32)+tag(16)+ephemeral pubkey(65)
        totalBytes += estimateMsgBytes({ fromRole, toRole, encryptedBlob: 'x'.repeat(145) });
      }
    }
    metrics.B2 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: msgCount, msg_bytes: totalBytes };
  }

  // ── B3: Feldman verification + aggregation (local n*(n-1) verify ops) ────────
  {
    const t0 = performance.now();
    let verifyOps = 0;
    for (const toRole of roles) {
      const toId = roleToId[toRole];
      const receivedShares = [];
      for (const fromRole of roles) {
        if (fromRole === toRole) continue;
        const share = shares[fromRole][toRole];
        if (!verifyShare(share, commitments[fromRole], toId, t)) throw new Error(`Feldman verify failed: ${fromRole}→${toRole}`);
        receivedShares.push(share);
        verifyOps++;
      }
      receivedShares.push(evaluatePolynomial(polynomials[toRole], toId)); // self-share f_j(j)
      finalShares[toRole] = aggregateShares(receivedShares);
    }
    metrics.B3 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: verifyOps, msg_bytes: 0 };
  }

  // ── B4: Signing pubkey derivation (backend-only, no network) ────────────────
  {
    const t0 = performance.now();
    const allComms = roles.map(r => commitments[r]);
    computeMasterPublicKey(allComms);
    for (const role of roles) computeSigningPublicKeyFromCommitments(allComms, roleToId[role], t);
    metrics.B4 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: 0, msg_bytes: 0 };
  }

  metrics._finalShares = finalShares;
  metrics._commitments = commitments;
  metrics._polynomials = polynomials;
  metrics._roles       = roles;
  metrics._roleToId    = roleToId;
  metrics._signingPubKeys = (() => {
    const allComms = roles.map(r => commitments[r]);
    const pk = {};
    for (const role of roles) pk[role] = computeSigningPublicKeyFromCommitments(allComms, roleToId[role], t);
    return pk;
  })();

  return metrics;
}

// ─── Signing Simulation (FROST Schnorr — Round 1 nonce + Round 2 z-share) ───────

function lagrangeCoeff(xi, ids) {
  let num = 1n, den = 1n;
  for (const xj of ids) {
    if (xi === xj) continue;
    num = (num * (0n - BigInt(xj)) % ORDER + ORDER) % ORDER;
    den = den * ((BigInt(xi) - BigInt(xj) + ORDER) % ORDER) % ORDER;
  }
  return num * modInv(den, ORDER) % ORDER;
}

function modInv(a, m) {
  a = ((a % m) + m) % m;
  let [mm, x0, x1] = [m, 0n, 1n];
  while (a > 1n) { const q = a / mm; [mm, a] = [a % mm, mm]; [x0, x1] = [x1 - q * x0, x0]; }
  return (x1 + m) % m;
}

/**
 * Simulate one full FROST signing round for (t, n): Round 1 (nonce gen) + Round 2 (z-share).
 * Returns { R1, R2 } phase metrics. Một lần gọi = 1 chữ ký TSS hoàn tất (đơn vị throughput).
 *
 * @param {string[]|null} signerRoles  Tập role ký (mặc định t role đầu). Truyền tập tùy ý để
 *   ký bằng subset sống sót bất kỳ — Lagrange tái dựng đúng với mọi t-subset (kiểm thử liveness).
 */
export function runSigning(t, n, dkgResult, signerRoles = null) {
  const { _finalShares: finalShares, _roles: roles, _roleToId: roleToId } = dkgResult;
  const metrics = {};
  signerRoles = signerRoles || roles.slice(0, t);
  if (signerRoles.length !== t) throw new Error(`signerRoles phải có đúng t=${t} role, nhận ${signerRoles.length}`);
  const signerIds = signerRoles.map(r => roleToId[r]);
  const msgHash = '0x' + randomBytes(32).toString('hex');

  // ── Round 1: Nonce generation (t submissions) ───────────────────────────────
  let nonces;
  {
    const t0 = performance.now();
    nonces = {};
    let totalBytes = 0;
    for (const role of signerRoles) {
      const k1 = randomScalar(), k2 = randomScalar();
      const R1 = ec.g.mul(k1.toString(16)), R2 = ec.g.mul(k2.toString(16));
      nonces[role] = {
        k1, k2,
        R1x: BigInt('0x' + R1.getX().toString(16)), R1y: BigInt('0x' + R1.getY().toString(16)),
        R2x: BigInt('0x' + R2.getX().toString(16)), R2y: BigInt('0x' + R2.getY().toString(16)),
      };
      totalBytes += estimateMsgBytes({ role, R1x: R1.getX().toString(16), R1y: R1.getY().toString(16), R2x: R2.getX().toString(16), R2y: R2.getY().toString(16) });
    }
    metrics.R1 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: t, msg_bytes: totalBytes };
  }

  // ── Round 2: binding factors + z-share computation (t submissions + 1 broadcast) ─
  {
    const t0 = performance.now();
    const lambdas = {};
    for (const role of signerRoles) lambdas[role] = lagrangeCoeff(roleToId[role], signerIds);

    const bindingFactors = {};
    for (const role of signerRoles) {
      const input = `${role}${msgHash}${nonces[role].R1x}${nonces[role].R2x}`;
      bindingFactors[role] = BigInt('0x' + createHash('sha256').update(input).digest('hex')) % ORDER;
    }

    let totalBytes = 0;
    for (const role of signerRoles) {
      const { k1, k2 } = nonces[role];
      const rho = bindingFactors[role];
      const share = BigInt('0x' + finalShares[role].replace(/^0x/, ''));
      const lambda = lambdas[role];
      const e = BigInt('0x' + createHash('sha256').update(msgHash + role).digest('hex')) % ORDER;
      // z_i = k1 + k2*ρ + e*λ*s_i  (mod ORDER)
      const z = (k1 + k2 * rho % ORDER + e * lambda % ORDER * share % ORDER) % ORDER;
      totalBytes += estimateMsgBytes({ role, z: z.toString(16) });
    }
    metrics.R2 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: t + 1, msg_bytes: totalBytes };
  }

  return metrics;
}

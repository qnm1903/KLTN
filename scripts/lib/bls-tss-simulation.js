/**
 * BLS Threshold Simulation Core — Feldman VSS DKG + threshold BLS signing (in-process).
 *
 * Đối chứng off-chain cho lược đồ chữ ký ngưỡng BLS (BLS12-381) dùng @noble/curves.
 * Mục đích: đo chi phí tính toán mỗi bên (DKG + ký) và thông lượng bộ tổng hợp, để xếp
 * cạnh Schnorr-FROST (tss-simulation.js) trong Bảng B off-chain.
 *
 * Khác biệt then chốt với FROST: BLS ký KHÔNG tương tác (1 vòng) — mỗi bên xuất một mảnh
 * σ_i = s_i·H(m) ∈ G1, bộ tổng hợp gộp Lagrange-trong-mũ: σ = Σ λ_i·σ_i. Đổi lại, xác minh
 * dùng pairing (đắt, đã đo on-chain ở BlsEscrow).
 */

import { performance } from 'perf_hooks';
import { randomBytes } from 'crypto';
import { bls12_381 } from '@noble/curves/bls12-381';

export const G1 = bls12_381.G1.ProjectivePoint;
export const G2 = bls12_381.G2.ProjectivePoint;
export const R  = bls12_381.params.r;

const mod = (a) => ((a % R) + R) % R;

export function randomScalar() {
  let s;
  do { s = BigInt('0x' + randomBytes(32).toString('hex')) % R; } while (s === 0n);
  return s;
}

export function bftMin(n) { return 2 * Math.floor((n - 1) / 3) + 1; }

function evalPoly(coeffs, x) {
  // Horner mod r
  const xx = BigInt(x);
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) acc = mod(acc * xx + coeffs[i]);
  return acc;
}

function modInv(a, m) {
  a = ((a % m) + m) % m;
  let [mm, x0, x1] = [m, 0n, 1n];
  while (a > 1n) { const q = a / mm; [mm, a] = [a % mm, mm]; [x0, x1] = [x1 - q * x0, x0]; }
  return (x1 + m) % m;
}

function lagrangeCoeff(xi, ids) {
  let num = 1n, den = 1n;
  for (const xj of ids) {
    if (xi === xj) continue;
    num = mod(num * mod(0n - BigInt(xj)));
    den = mod(den * mod(BigInt(xi) - BigInt(xj)));
  }
  return mod(num * modInv(den, R));
}

// ─── DKG (Feldman VSS over scalar field r, commitments in G1) ────────────────────

/**
 * Mô phỏng DKG ngưỡng BLS cho (t,n). Trả về per-phase metrics + finalShares để ký.
 * ID các bên = 1..n. Cam kết Feldman trong G1; xác minh: s_ij·G1 == Σ C_jk·(id_i^k).
 */
export function runDKG(t, n) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const metrics = {};
  const polys = {}, comms = {}, finalShares = {};

  // B1: sinh đa thức bậc t-1 + cam kết Feldman (mỗi bên broadcast t điểm G1)
  {
    const t0 = performance.now();
    for (const id of ids) {
      const coeffs = Array.from({ length: t }, () => randomScalar());
      polys[id] = coeffs;
      comms[id] = coeffs.map((c) => G1.BASE.multiply(c)); // t G1 muls
    }
    metrics.B1 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: n };
  }

  // B2: phân phối mảnh điểm-điểm (n*(n-1) đánh giá đa thức)
  const shares = {};
  {
    const t0 = performance.now();
    let cnt = 0;
    for (const from of ids) {
      shares[from] = {};
      for (const to of ids) { shares[from][to] = evalPoly(polys[from], to); cnt++; }
    }
    metrics.B2 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: cnt };
  }

  // B3: xác minh Feldman (mỗi bên verify n-1 mảnh, mỗi verify t G1 muls) + gộp share
  {
    const t0 = performance.now();
    let verifyOps = 0;
    for (const to of ids) {
      let agg = 0n;
      for (const from of ids) {
        const s = shares[from][to];
        // LHS = s·G1 ; RHS = Σ_k C_from[k] · (to^k mod r)
        const lhs = G1.BASE.multiply(s);
        let rhs = G1.ZERO, xp = 1n;
        for (let k = 0; k < t; k++) {
          rhs = rhs.add(comms[from][k].multiply(xp === 0n ? R : xp)); // tránh multiply(0)
          xp = mod(xp * BigInt(to));
        }
        if (!lhs.equals(rhs)) throw new Error(`Feldman verify failed ${from}->${to}`);
        agg = mod(agg + s);
        verifyOps++;
      }
      finalShares[to] = agg;
    }
    metrics.B3 = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: verifyOps };
  }

  metrics._finalShares = finalShares;
  metrics._ids = ids;
  return metrics;
}

// ─── Threshold BLS signing (1 round: partial sign + Lagrange aggregate) ──────────

/**
 * Một lần ký ngưỡng BLS hoàn tất cho (t,n): t mảnh σ_i = s_i·H(m), gộp σ = Σ λ_i·σ_i.
 * 1 lần gọi = 1 chữ ký hoàn tất (đơn vị thông lượng).
 */
export function runSigning(t, n, dkg, signerIds = null) {
  const { _finalShares: finalShares, _ids: ids } = dkg;
  signerIds = signerIds || ids.slice(0, t);
  if (signerIds.length !== t) throw new Error(`signerIds phải có đúng t=${t}`);
  const metrics = {};

  const Hm = bls12_381.G1.hashToCurve(randomBytes(32)); // H(m) ∈ G1

  // Round 1 (BLS không tương tác): mỗi bên xuất 1 mảnh σ_i = s_i·H(m)
  let partials;
  {
    const t0 = performance.now();
    partials = signerIds.map((id) => ({ id, sig: Hm.multiply(finalShares[id]) }));
    metrics.SIGN = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: t };
  }

  // Aggregation: σ = Σ λ_i · σ_i (t G1 muls + adds) — chi phí bộ tổng hợp
  {
    const t0 = performance.now();
    let sigma = G1.ZERO;
    for (const { id, sig } of partials) {
      const lambda = lagrangeCoeff(id, signerIds);
      sigma = sigma.add(sig.multiply(lambda === 0n ? R : lambda));
    }
    metrics.AGG = { time_ms: +(performance.now() - t0).toFixed(3), msg_count: 1 };
  }

  return metrics;
}

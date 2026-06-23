/**
 * BLS Threshold Off-chain — chi phí tính toán mỗi bên (DKG + ký) và thông lượng bộ tổng
 * hợp cho lược đồ chữ ký ngưỡng BLS12-381. Đối chứng với Schnorr-FROST
 * (experiment-party-compute.js) trong Bảng B off-chain.
 *
 *   GEN     sinh đa thức bậc t-1 + cam kết Feldman (t G1 mul)
 *   DIST    tính n-1 mảnh gửi bên khác
 *   VERIFY  xác minh n-1 mảnh nhận (mỗi verify ~ t+1 G1 mul) — đắt nhất
 *   AGG     gộp final share
 *   SIGN    1 mảnh σ_i = s_i·H(m) (1 hashToCurve + 1 G1 mul)
 *   AGGSIG  bộ tổng hợp gộp t mảnh: σ = Σ λ_i·σ_i (t G1 mul) — chi phí aggregator
 *
 * Usage:
 *   node scripts/experiment-bls-offchain.js
 *   node scripts/experiment-bls-offchain.js --n "5 7 11 15 21 25 31 40 55" --iter 20 --output experiments/bls-offchain.csv
 */

import { performance } from 'perf_hooks';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { parseArgs } from 'util';
import { bls12_381 } from '@noble/curves/bls12-381';
import { G1, R, randomScalar, bftMin } from './lib/bls-tss-simulation.js';

const { values: args } = parseArgs({
  options: {
    n:      { type: 'string', default: '5 7 11 15 21 25 31 40 55' },
    iter:   { type: 'string', default: '15' },
    warmup: { type: 'string', default: '3' },
    output: { type: 'string', default: '' },
  },
  strict: false,
});

const ITER    = Math.max(1, parseInt(args.iter) || 15);
const WARMUP  = Math.max(0, parseInt(args.warmup) || 3);
const CONFIGS = args.n.split(/[\s,]+/).map(Number).filter((x) => x >= 3).map((n) => [bftMin(n), n]);
const PHASES  = ['GEN', 'DIST', 'VERIFY', 'AGG', 'SIGN', 'AGGSIG'];
const now = () => performance.now();
const mod = (a) => ((a % R) + R) % R;

function evalPoly(coeffs, x) { const xx = BigInt(x); let acc = 0n; for (let i = coeffs.length - 1; i >= 0; i--) acc = mod(acc * xx + coeffs[i]); return acc; }
function modInv(a, m) { a = ((a % m) + m) % m; let [mm, x0, x1] = [m, 0n, 1n]; while (a > 1n) { const q = a / mm;[mm, a] = [a % mm, mm];[x0, x1] = [x1 - q * x0, x0]; } return (x1 + m) % m; }
function lagrange(xi, ids) { let num = 1n, den = 1n; for (const xj of ids) { if (xi === xj) continue; num = mod(num * mod(-BigInt(xj))); den = mod(den * mod(BigInt(xi) - BigInt(xj))); } return mod(num * modInv(den, R)); }

/** Đo workload tính toán của 1 party (focalId=1) + chi phí gộp của aggregator, cấu hình (t,n). */
function measureParty(t, n) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const focal = 1;
  const others = ids.filter((id) => id !== focal);

  // Setup (không tính giờ): dữ liệu các bên khác
  const otherData = others.map((id) => {
    const coeffs = Array.from({ length: t }, () => randomScalar());
    return { id, comms: coeffs.map((c) => G1.BASE.multiply(c)), shareToFocal: evalPoly(coeffs, focal) };
  });

  const m = {};
  let s = now();
  const coeffs = Array.from({ length: t }, () => randomScalar());
  const myComms = coeffs.map((c) => G1.BASE.multiply(c));
  m.GEN = now() - s;

  s = now();
  for (const id of others) evalPoly(coeffs, id);
  m.DIST = now() - s;

  s = now();
  const received = [];
  for (const o of otherData) {
    const lhs = G1.BASE.multiply(o.shareToFocal);
    let rhs = G1.ZERO, xp = 1n;
    for (let k = 0; k < t; k++) { rhs = rhs.add(o.comms[k].multiply(xp === 0n ? R : xp)); xp = mod(xp * BigInt(focal)); }
    if (!lhs.equals(rhs)) throw new Error('verify failed');
    received.push(o.shareToFocal);
  }
  m.VERIFY = now() - s;

  s = now();
  let finalShare = evalPoly(coeffs, focal);
  for (const sh of received) finalShare = mod(finalShare + sh);
  m.AGG = now() - s;

  // SIGN — 1 mảnh σ_i
  const Hm = bls12_381.G1.hashToCurve(randomBytes(32));
  s = now();
  const partial = Hm.multiply(finalShare === 0n ? R : finalShare);
  m.SIGN = now() - s;

  // AGGSIG — aggregator gộp t mảnh (dùng cùng partial nhân Lagrange, mô phỏng t mảnh)
  const signerIds = ids.slice(0, t);
  s = now();
  let sigma = G1.ZERO;
  for (const id of signerIds) { const lam = lagrange(id, signerIds); sigma = sigma.add(partial.multiply(lam === 0n ? R : lam)); }
  m.AGGSIG = now() - s;

  return m;
}

function stat(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const avg = a.reduce((p, c) => p + c, 0) / a.length;
  const std = Math.sqrt(a.reduce((p, c) => p + (c - avg) ** 2, 0) / a.length);
  return { avg, min: a[0], max: a[a.length - 1], p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))], std };
}

console.log(`\nBLS threshold off-chain — ${CONFIGS.length} config × ${ITER} lần (warmup ${WARMUP})\n`);
const rows = [];
for (const [t, n] of CONFIGS) {
  const samples = Object.fromEntries(PHASES.map((p) => [p, []]));
  for (let i = 0; i < WARMUP + ITER; i++) {
    const m = measureParty(t, n);
    if (i < WARMUP) continue;
    for (const p of PHASES) samples[p].push(m[p]);
  }
  const st = Object.fromEntries(PHASES.map((p) => [p, stat(samples[p])]));
  const dkg  = st.GEN.avg + st.DIST.avg + st.VERIFY.avg + st.AGG.avg;
  const sign = st.SIGN.avg;
  const aggThroughput = 1000 / st.AGGSIG.avg; // chữ ký/giây (đơn luồng, chỉ pha gộp)
  rows.push({ t, n, st, dkg, sign, aggsig: st.AGGSIG.avg, aggThroughput });
  console.log(`── ${t}-of-${n} ──  DKG/party: ${dkg.toFixed(2)} ms | Ký(mảnh): ${sign.toFixed(3)} ms | Gộp(aggregator): ${st.AGGSIG.avg.toFixed(3)} ms | ~${aggThroughput.toFixed(0)} sig/s`);
}

if (args.output) {
  const header = 'config,DKG_per_party_ms,sign_partial_ms,aggregate_ms,agg_throughput_sig_per_s,VERIFY_avg_ms\n';
  const lines = rows.map((r) => `${r.t}-of-${r.n},${r.dkg.toFixed(3)},${r.sign.toFixed(3)},${r.aggsig.toFixed(3)},${r.aggThroughput.toFixed(1)},${r.st.VERIFY.avg.toFixed(3)}`);
  writeFileSync(args.output, header + lines.join('\n') + '\n');
  console.log(`\nĐã lưu → ${args.output}`);
}

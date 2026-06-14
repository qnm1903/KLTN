/**
 * Per-Party Computation (mô phỏng generic) — đo chi phí tính toán mật mã MỘT BÊN tự
 * thực hiện trên thiết bị của họ, cho bất kỳ cấu hình (t,n).
 *
 * Vì sao tách khỏi frontend: code UI (dkg-crypto.js) khóa cứng THRESHOLD=5 (chỉ phục vụ
 * triển khai 5-of-7), không quét được t. Script này dùng CÙNG primitive Pedersen VSS
 * (backend/src/crypto/pedersen-vss.js) — cùng phép toán secp256k1 chạy trên trình duyệt —
 * nên số đo đại diện cho chi phí client, đồng thời quét được mọi (t,n) ta cần test.
 *
 * Đo workload của 1 party (focalId) trong escrow (t,n) — chỉ phần VSS/EC (loại transport
 * ECDH/AES vì độc lập (t,n) và là chi tiết riêng của frontend):
 *   GEN     sinh polynomial bậc (t-1) + Feldman commitments (t EC mul)
 *   DIST    tính share gửi cho n-1 bên khác
 *   VERIFY  verify n-1 share nhận được (mỗi verify = t EC mul) — đắt nhất
 *   AGG     tổng hợp final share + suy ra signing pubkey
 *   R1      sinh FROST dual-nonce (2 EC mul)
 *   R2      tính z_i = k1 + k2·ρ + e·s (số học modular)
 *
 * Usage:
 *   node scripts/experiment-party-compute.js
 *   node scripts/experiment-party-compute.js --n "3 5 7 11 15 21" --iter 30 --output experiments/party-compute.csv
 */

import { performance } from 'perf_hooks';
import { randomBytes, createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { parseArgs } from 'util';
import { ec, ORDER, randomScalar, generateRoleToId, bftMin } from './lib/tss-simulation.js';
import {
  generatePolynomial, computeCommitments, evaluatePolynomial,
  verifyShare, aggregateShares, computeSigningPublicKeyFromCommitments,
} from '../backend/src/crypto/pedersen-vss.js';

const PHASES = ['GEN', 'DIST', 'VERIFY', 'AGG', 'R1', 'R2'];

const { values: args } = parseArgs({
  options: {
    n:      { type: 'string', default: '3 5 7 11 15 21' }, // t = ngưỡng BFT theo n
    iter:   { type: 'string', default: '30' },
    warmup: { type: 'string', default: '5' },
    output: { type: 'string', default: '' },
  },
  strict: false,
});

const ITER = Math.max(1, parseInt(args.iter) || 30);
const WARMUP = Math.max(0, parseInt(args.warmup) || 5);
const CONFIGS = args.n.split(/[\s,]+/).map(Number).filter((x) => x >= 3).map((n) => [bftMin(n), n]);
const now = () => performance.now();

/** Đo 1 lần toàn bộ workload tính toán của 1 party trong cấu hình (t,n). */
function measureParty(t, n, focalId = 1) {
  const roleToId = generateRoleToId(n);
  const ids = Object.values(roleToId);
  const otherIds = ids.filter((id) => id !== focalId);

  // ── Setup (KHÔNG tính giờ): dữ liệu các bên KHÁC vốn sinh trên thiết bị họ ──
  const others = otherIds.map((id) => {
    const { coeffs } = generatePolynomial(t);
    return { id, commitments: computeCommitments(coeffs), shareToFocal: evaluatePolynomial(coeffs, focalId) };
  });

  const m = {};
  // GEN
  let s = now();
  const { coeffs } = generatePolynomial(t);
  const myComms = computeCommitments(coeffs);
  m.GEN = now() - s;
  // DIST — share focal gửi cho từng bên khác
  s = now();
  for (const id of otherIds) evaluatePolynomial(coeffs, id);
  m.DIST = now() - s;
  // VERIFY — verify share nhận từ từng bên khác (Feldman)
  s = now();
  const received = [];
  for (const o of others) {
    verifyShare(o.shareToFocal, o.commitments, focalId, t);
    received.push(o.shareToFocal);
  }
  m.VERIFY = now() - s;
  // AGG — final signing share + signing pubkey của focal
  s = now();
  received.push(evaluatePolynomial(coeffs, focalId)); // self-share
  const finalShare = aggregateShares(received);
  const allComms = [myComms, ...others.map((o) => o.commitments)];
  computeSigningPublicKeyFromCommitments(allComms, focalId, t);
  m.AGG = now() - s;
  // R1 — FROST dual-nonce
  s = now();
  const k1 = randomScalar(), k2 = randomScalar();
  ec.g.mul(k1.toString(16)); ec.g.mul(k2.toString(16));
  m.R1 = now() - s;
  // R2 — z_i = k1 + k2·ρ + e·s
  s = now();
  const rho = BigInt('0x' + createHash('sha256').update(randomBytes(32)).digest('hex')) % ORDER;
  const e = BigInt('0x' + createHash('sha256').update(randomBytes(32)).digest('hex')) % ORDER;
  const sScalar = BigInt(finalShare.replace(/^0x/, '0x')) % ORDER;
  const z = (k1 + (k2 * rho) % ORDER + (e * sScalar) % ORDER) % ORDER;
  void z;
  m.R2 = now() - s;
  return m;
}

function stats(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const avg = a.reduce((p, c) => p + c, 0) / a.length;
  const std = Math.sqrt(a.reduce((p, c) => p + (c - avg) ** 2, 0) / a.length);
  return { avg, min: a[0], max: a[a.length - 1], p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))], std };
}

console.log(`\nPer-party compute (generic) — ${CONFIGS.length} config × ${ITER} lần (warmup ${WARMUP})\n`);
const rows = [];
for (const [t, n] of CONFIGS) {
  const samples = Object.fromEntries(PHASES.map((p) => [p, []]));
  const totals = [];
  for (let i = 0; i < WARMUP + ITER; i++) {
    const m = measureParty(t, n);
    if (i < WARMUP) continue; // loại cold-start (JIT)
    let tot = 0;
    for (const p of PHASES) { samples[p].push(m[p]); tot += m[p]; }
    totals.push(tot);
  }
  const st = Object.fromEntries(PHASES.map((p) => [p, stats(samples[p])]));
  const tot = stats(totals);
  const dkg = st.GEN.avg + st.DIST.avg + st.VERIFY.avg + st.AGG.avg;
  const sign = st.R1.avg + st.R2.avg;

  console.log(`── ${t}-of-${n} ──  (avg ms)`);
  for (const p of PHASES) console.log(`   ${p.padEnd(7)}: ${st[p].avg.toFixed(3)}  (p95 ${st[p].p95.toFixed(3)})`);
  console.log(`   DKG: ${dkg.toFixed(2)} ms | Ký: ${sign.toFixed(3)} ms | TỔNG/party: ${tot.avg.toFixed(2)} ms (p95 ${tot.p95.toFixed(2)})\n`);
  rows.push({ t, n, st, tot, dkg, sign });
}

if (args.output) {
  const header = 'config,phase,avg_ms,p95_ms,min_ms,max_ms,std_ms\n';
  const lines = [];
  for (const r of rows) {
    const cfg = `${r.t}-of-${r.n}`;
    for (const p of PHASES) {
      const s = r.st[p];
      lines.push(`${cfg},${p},${s.avg.toFixed(3)},${s.p95.toFixed(3)},${s.min.toFixed(3)},${s.max.toFixed(3)},${s.std.toFixed(3)}`);
    }
    lines.push(`${cfg},DKG_TOTAL,${r.dkg.toFixed(3)},,,,`);
    lines.push(`${cfg},SIGN_TOTAL,${r.sign.toFixed(3)},,,,`);
    lines.push(`${cfg},PARTY_TOTAL,${r.tot.avg.toFixed(3)},${r.tot.p95.toFixed(3)},${r.tot.min.toFixed(3)},${r.tot.max.toFixed(3)},${r.tot.std.toFixed(3)}`);
  }
  writeFileSync(args.output, header + lines.join('\n') + '\n');
  console.log(`Đã lưu → ${args.output}`);
}

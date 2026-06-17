/**
 * TSS Party Compute Benchmark — kết hợp timing + message counts
 *
 * Đo: thời gian tính toán của MỘT party (chạy song song với n-1 parties khác)
 * cho từng pha DKG và ký FROST trên nhiều config (t-of-n).
 *
 * Msg counts: tính theo công thức giao thức (không cần simulation):
 *   M_DKG  = B1 + B2 + B3 = n + n(n-1) + n(n-1) = n(2n-1)
 *   M_sign = R1 + R2       = t + (t+1)            = 2t+1
 *
 * Chạy: node benchmark-party-compute.js  (từ thư mục escrow-tss/backend/)
 * Output: ../experiments/party-compute-{date}-combined.csv
 */

import {
  generatePolynomial,
  computeCommitments,
  evaluatePolynomial,
  verifyShare,
  aggregateShares,
  computeSigningPublicKey,
} from '../backend/src/crypto/pedersen-vss.js';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─── Configs ──────────────────────────────────────────────────────────────────

const CONFIGS = [
  { t: 3, n: 5  },
  { t: 5, n: 7  },   // production default
  { t: 7, n: 11 },
  { t: 9, n: 15 },
  { t: 13, n: 21 },
  { t: 17, n: 25 },
  { t: 21, n: 31 },
  { t: 27, n: 40 },
  { t: 37, n: 55 },
];

const WARMUP = 5;
const RUNS   = 20;
// Số lần đo mỗi ID khi sweep VERIFY (1 là đủ — variance chính đến từ khác biệt giữa các ID,
// không phải noise trong một lần đo)
const VERIFY_REPS_PER_ID = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const hrNow    = () => process.hrtime.bigint();
const toMs     = (ns) => Number(ns) / 1_000_000;
const randHex  = () => randomBytes(32).toString('hex');
const randBig  = () => BigInt('0x' + randHex()) % ORDER || 1n;

function stats(arr) {
  const n   = arr.length;
  const avg = arr.reduce((s, x) => s + x, 0) / n;
  const std = Math.sqrt(arr.map(x => (x - avg) ** 2).reduce((s, x) => s + x, 0) / n);
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    avg,
    std,
    p95: sorted[Math.floor(n * 0.95)],
    min: sorted[0],
    max: sorted[n - 1],
  };
}

// ─── DKG per-party computation ────────────────────────────────────────────────
//
// Mỗi party i thực hiện 4 bước độc lập (song song với các parties khác):
//
//  GEN    : sinh polynomial f_i(x) bậc t-1 + t Feldman commitments C_ij = a_j * G
//           → t EC scalar mults, tương ứng B1 (broadcast commitments)
//
//  DIST   : tính f_i(id_j) cho n-1 parties khác
//           → (n-1) Horner evaluations (field arithmetic only), tương ứng B2
//
//  VERIFY : xác minh n-1 shares nhận từ các party khác tại vị trí myId
//           verifyShare(s, C, myId, t): 1 + t EC scalar mults mỗi lần
//           → (n-1)(t+1) EC scalar mults tổng, tương ứng B3
//           Chi phí phụ thuộc myId vì xPow = myId^k mod ORDER:
//             - myId nhỏ (e.g. 1)  → xPow nhỏ/trivial → quá nhanh (không đại diện)
//             - myId lớn (e.g. n)  → xPow đầy đủ 256-bit → chậm nhất
//           → Cần sweep tất cả IDs để có avg và max thực tế
//
//  AGG    : tổng hợp n shares nhận được + tính signing pubkey
//           → n field additions + 1 EC scalar mult, tương ứng B4 (local)

function measureGENDISTAGG(t, n, myId, allIds) {
  const ph = {};

  let t0 = hrNow();
  const { coeffs }   = generatePolynomial(t);
  const myCommitments = computeCommitments(coeffs);
  ph.GEN = toMs(hrNow() - t0);

  t0 = hrNow();
  for (const id of allIds) {
    if (id !== myId) evaluatePolynomial(coeffs, id);
  }
  ph.DIST = toMs(hrNow() - t0);

  t0 = hrNow();
  const inShares  = allIds.map(id => evaluatePolynomial(coeffs, id));
  const finalShare = aggregateShares(inShares);
  computeSigningPublicKey(finalShare);
  ph.AGG = toMs(hrNow() - t0);

  return { ph, coeffs, myCommitments };
}

// Đo VERIFY cho một party ID cụ thể (n-1 lần verifyShare tại vị trí `id`).
// VERIFY là phase duy nhất phụ thuộc mạnh vào ID vì xPow = id^k mod ORDER.
function measureVERIFYForId(coeffs, myCommitments, id, n, t) {
  const shareAtId = evaluatePolynomial(coeffs, id);
  const t0 = hrNow();
  for (let i = 0; i < n - 1; i++) {
    verifyShare(shareAtId, myCommitments, id, t);
  }
  return toMs(hrNow() - t0);
}

// Sweep tất cả n party IDs và trả về thời gian VERIFY cho từng ID.
// Trả về: { perIdMs: number[], avg: number, max: number, maxId: number }
function sweepVerifyAllIds(coeffs, myCommitments, allIds, n, t) {
  const perIdMs = [];
  for (const id of allIds) {
    // Lấy trung bình VERIFY_REPS_PER_ID lần đo để giảm noise
    let sum = 0;
    for (let r = 0; r < VERIFY_REPS_PER_ID; r++) {
      sum += measureVERIFYForId(coeffs, myCommitments, id, n, t);
    }
    perIdMs.push(sum / VERIFY_REPS_PER_ID);
  }
  const avg    = perIdMs.reduce((s, x) => s + x, 0) / perIdMs.length;
  const max    = Math.max(...perIdMs);
  const maxId  = allIds[perIdMs.indexOf(max)];
  return { perIdMs, avg, max, maxId };
}

// ─── Signing per-party computation (FROST 2-round) ───────────────────────────
//
//  R1 : sinh 2 nonces k1,k2 + tính R1_i = k1*G, R2_i = k2*G
//       → 2 EC scalar mults (dual nonce FROST)
//
//  R2 : nhận ρ_i (binding factor) và e (challenge) từ coordinator
//       tính z_i = k1 + ρ_i*k2 + e*s_i  (field arithmetic only, không có EC mult)

function measureSignParty() {
  const ph = {};

  // R1: 2 random nonces + 2 EC scalar mults (k1*G, k2*G)
  let t0 = hrNow();
  const k1 = randHex();
  const k2 = randHex();
  // computeCommitments([k1, k2]) thực hiện đúng 2 × (scalar * G) — cùng operation như k*G
  computeCommitments([k1, k2]);
  ph.R1 = toMs(hrNow() - t0);

  // R2: z = k1 + ρ*k2 + e*s  (field BigInt arithmetic)
  t0 = hrNow();
  const k1b =  BigInt('0x' + k1) % ORDER;
  const k2b =  BigInt('0x' + k2) % ORDER;
  const rho  = randBig();
  const e    = randBig();
  const s    = randBig();
  // z_i = k1 + ρ_i*k2 + e*s_i  (mod ORDER)
  const _z = (k1b + (rho * k2b % ORDER) + (e * s % ORDER)) % ORDER;
  ph.R2 = toMs(hrNow() - t0);

  return ph;
}

// ─── Message counts (analytical) ─────────────────────────────────────────────

function msgCounts(t, n) {
  const B1 = n;             // n parties each broadcast commitments
  const B2 = n * (n - 1);  // n parties × (n-1) unicast shares
  const B3 = n * (n - 1);  // n parties × (n-1) verification broadcasts
  const B4 = 0;             // local aggregation — no messages
  const R1 = t;             // t signers → coordinator: nonce commitments
  const R2 = t + 1;         // coordinator → t parties (1 broadcast) + t parties → coordinator (z_i)
  return {
    B1, B2, B3, B4, R1, R2,
    DKG:   B1 + B2 + B3,         // = n(2n-1)
    SIGN:  R1 + R2,              // = 2t+1
    TOTAL: B1 + B2 + B3 + R1 + R2,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  console.log(`\nTSS Party Compute Benchmark  [${date}]`);
  console.log(`Warmup=${WARMUP}, Runs=${RUNS}\n`);
  console.log('Config      DKG(ms)   SIGN(ms)  TOTAL(ms)  MSG_DKG  MSG_SIGN  MSG_TOTAL');
  console.log('─'.repeat(76));

  // max_party_ms = thời gian party chậm nhất (= wall-clock DKG thực tế khi song song)
  const csvRows = ['config,phase,avg_ms,p95_ms,min_ms,max_ms,std_ms,max_party_ms,msg_count'];

  const PHASE_MSG_KEY = { GEN: 'B1', DIST: 'B2', VERIFY: 'B3', AGG: 'B4', R1: 'R1', R2: 'R2' };

  function addRow(config, phase, s, msgCount, maxPartyMs = '') {
    csvRows.push([
      config, phase,
      s.avg?.toFixed(3) ?? '',
      s.p95?.toFixed(3) ?? '',
      s.min?.toFixed(3) ?? '',
      s.max?.toFixed(3) ?? '',
      s.std?.toFixed(3) ?? '',
      typeof maxPartyMs === 'number' ? maxPartyMs.toFixed(3) : maxPartyMs,
      msgCount,
    ].join(','));
  }

  for (const { t, n } of CONFIGS) {
    const allIds = Array.from({ length: n }, (_, i) => i + 1);
    const medId  = Math.ceil(n / 2);  // dùng cho GEN/DIST/AGG warmup
    const msgs   = msgCounts(t, n);
    const cfg    = `${t}-of-${n}`;

    const gdaSamples  = { GEN: [], DIST: [], AGG: [] };
    const signSamples = { R1: [],  R2: [] };

    // Warmup với medId — đủ để JIT compile và warm CPU/cache
    for (let i = 0; i < WARMUP; i++) {
      measureGENDISTAGG(t, n, medId, allIds);
      measureSignParty();
    }

    // Đo GEN, DIST, AGG với RUNS lần (không phụ thuộc myId đáng kể)
    let warmCoeffs, warmCommitments;
    for (let i = 0; i < RUNS; i++) {
      const { ph, coeffs, myCommitments } = measureGENDISTAGG(t, n, medId, allIds);
      for (const [k, v] of Object.entries(ph)) gdaSamples[k].push(v);
      // Giữ lại một bộ coeffs/commitments dùng cho sweep VERIFY
      if (i === RUNS - 1) { warmCoeffs = coeffs; warmCommitments = myCommitments; }
    }

    // Sweep VERIFY qua tất cả n IDs — đây là phép đo thực tế nhất:
    // mỗi party trong mạng có một ID khác nhau, wall-clock DKG = max của tất cả.
    process.stdout.write(`  ${cfg}: sweeping VERIFY for ${n} IDs...`);
    const verifySweep = sweepVerifyAllIds(warmCoeffs, warmCommitments, allIds, n, t);
    process.stdout.write(` avg=${verifySweep.avg.toFixed(0)}ms max=${verifySweep.max.toFixed(0)}ms (id=${verifySweep.maxId})\n`);

    // Đo SIGN
    for (let i = 0; i < RUNS; i++) {
      const sign = measureSignParty();
      for (const [k, v] of Object.entries(sign)) signSamples[k].push(v);
    }

    // DKG phase rows — VERIFY dùng avg từ sweep, max_party = max từ sweep
    const genS  = stats(gdaSamples.GEN);
    const distS = stats(gdaSamples.DIST);
    const aggS  = stats(gdaSamples.AGG);
    // Synthetic stats object cho VERIFY: avg = avg across IDs, max = max across IDs
    const verifyAvg = verifySweep.avg;
    const verifyS = {
      avg: verifyAvg,
      p95: verifySweep.perIdMs.sort((a,b)=>a-b)[Math.floor(n * 0.95)] ?? verifySweep.max,
      min: Math.min(...verifySweep.perIdMs),
      max: verifySweep.max,
      std: Math.sqrt(verifySweep.perIdMs.map(x=>(x-verifyAvg)**2).reduce((s,x)=>s+x,0)/n),
    };

    addRow(cfg, 'GEN',    genS,    msgs.B1);
    addRow(cfg, 'DIST',   distS,   msgs.B2);
    addRow(cfg, 'VERIFY', verifyS, msgs.B3, verifySweep.max);
    addRow(cfg, 'AGG',    aggS,    msgs.B4);

    const dkgAvg  = genS.avg + distS.avg + verifyAvg + aggS.avg;
    const dkgMax  = genS.avg + distS.avg + verifySweep.max + aggS.avg;
    addRow(cfg, 'DKG_TOTAL', { avg: dkgAvg }, msgs.DKG, dkgMax);

    // SIGN phase rows
    let signTotal = 0;
    for (const phase of ['R1', 'R2']) {
      const s = stats(signSamples[phase]);
      signTotal += s.avg;
      addRow(cfg, phase, s, msgs[PHASE_MSG_KEY[phase]]);
    }
    addRow(cfg, 'SIGN_TOTAL', { avg: signTotal }, msgs.SIGN);

    const partyAvg = dkgAvg + signTotal;
    const partyMax = dkgMax + signTotal;
    addRow(cfg, 'PARTY_TOTAL', { avg: partyAvg }, msgs.TOTAL, partyMax);

    console.log(
      `${cfg.padEnd(12)}DKG avg=${dkgAvg.toFixed(0)}ms  max=${dkgMax.toFixed(0)}ms  ` +
      `sign=${signTotal.toFixed(1)}ms  msgs=${msgs.TOTAL}`
    );
  }

  const outPath = join(__dirname, `../experiments/party-compute-${date}-allids.csv`);
  writeFileSync(outPath, csvRows.join('\n') + '\n');
  console.log(`\nOutput: ${outPath}`);
}

main().catch(console.error);

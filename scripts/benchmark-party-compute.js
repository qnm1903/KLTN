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
//
//  AGG    : tổng hợp n shares nhận được + tính signing pubkey
//           → n field additions + 1 EC scalar mult, tương ứng B4 (local)

function measureDKGParty(t, n, myId, allIds) {
  const ph = {};

  // GEN: poly + commitments
  let t0 = hrNow();
  const { coeffs }   = generatePolynomial(t);
  const myCommitments = computeCommitments(coeffs);
  ph.GEN = toMs(hrNow() - t0);

  // DIST: evaluate at each other party's id
  t0 = hrNow();
  for (const id of allIds) {
    if (id !== myId) evaluatePolynomial(coeffs, id);
  }
  ph.DIST = toMs(hrNow() - t0);

  // VERIFY: verify n-1 incoming shares at myId
  // Timing dùng cùng commitments/share — EC operations không đổi theo giá trị cụ thể
  t0 = hrNow();
  const shareAtMyId = evaluatePolynomial(coeffs, myId);
  for (let i = 0; i < n - 1; i++) {
    verifyShare(shareAtMyId, myCommitments, myId, t);
  }
  ph.VERIFY = toMs(hrNow() - t0);

  // AGG: aggregate n shares → signing share → signing pubkey
  t0 = hrNow();
  const inShares  = allIds.map(id => evaluatePolynomial(coeffs, id));
  const finalShare = aggregateShares(inShares);
  computeSigningPublicKey(finalShare);
  ph.AGG = toMs(hrNow() - t0);

  return ph;
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

  const csvRows = ['config,phase,avg_ms,p95_ms,min_ms,max_ms,std_ms,msg_count'];

  const PHASE_MSG_KEY = { GEN: 'B1', DIST: 'B2', VERIFY: 'B3', AGG: 'B4', R1: 'R1', R2: 'R2' };

  function addRow(config, phase, s, msgCount) {
    csvRows.push([
      config, phase,
      s.avg?.toFixed(3) ?? '',
      s.p95?.toFixed(3) ?? '',
      s.min?.toFixed(3) ?? '',
      s.max?.toFixed(3) ?? '',
      s.std?.toFixed(3) ?? '',
      msgCount,
    ].join(','));
  }

  for (const { t, n } of CONFIGS) {
    const allIds = Array.from({ length: n }, (_, i) => i + 1);
    // Dùng myId = ceil(n/2) thay vì 1 — khi myId=1 thì xPow=1^k=1 mãi,
    // khiến pointMul(Cik, 1n) trivially fast và bỏ qua hầu hết EC scalar mults.
    // myId ở giữa range cho timing đại diện thực tế.
    const myId   = Math.ceil(n / 2);
    const msgs   = msgCounts(t, n);
    const cfg    = `${t}-of-${n}`;

    const dkgSamples  = { GEN: [], DIST: [], VERIFY: [], AGG: [] };
    const signSamples = { R1: [],  R2: [] };

    // Warmup (JIT, cache warm-up)
    for (let i = 0; i < WARMUP; i++) {
      measureDKGParty(t, n, myId, allIds);
      measureSignParty();
    }

    // Measurement
    for (let i = 0; i < RUNS; i++) {
      const dkg  = measureDKGParty(t, n, myId, allIds);
      const sign = measureSignParty();
      for (const [k, v] of Object.entries(dkg))  dkgSamples[k].push(v);
      for (const [k, v] of Object.entries(sign)) signSamples[k].push(v);
    }

    // DKG phase rows
    let dkgTotal = 0;
    for (const phase of ['GEN', 'DIST', 'VERIFY', 'AGG']) {
      const s = stats(dkgSamples[phase]);
      dkgTotal += s.avg;
      addRow(cfg, phase, s, msgs[PHASE_MSG_KEY[phase]]);
    }
    addRow(cfg, 'DKG_TOTAL', { avg: dkgTotal }, msgs.DKG);

    // Signing phase rows
    let signTotal = 0;
    for (const phase of ['R1', 'R2']) {
      const s = stats(signSamples[phase]);
      signTotal += s.avg;
      addRow(cfg, phase, s, msgs[PHASE_MSG_KEY[phase]]);
    }
    addRow(cfg, 'SIGN_TOTAL', { avg: signTotal }, msgs.SIGN);

    const partyTotal = dkgTotal + signTotal;
    addRow(cfg, 'PARTY_TOTAL', { avg: partyTotal }, msgs.TOTAL);

    console.log(
      `${cfg.padEnd(12)}${dkgTotal.toFixed(1).padStart(8)}  ` +
      `${signTotal.toFixed(2).padStart(8)}  ` +
      `${partyTotal.toFixed(1).padStart(9)}  ` +
      `${String(msgs.DKG).padStart(7)}  ` +
      `${String(msgs.SIGN).padStart(8)}  ` +
      `${String(msgs.TOTAL).padStart(9)}`
    );
  }

  const outPath = join(__dirname, `../experiments/party-compute-${date}-combined.csv`);
  writeFileSync(outPath, csvRows.join('\n') + '\n');
  console.log(`\nOutput: ${outPath}`);
}

main().catch(console.error);

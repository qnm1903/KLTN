/**
 * TSS Benchmark — đo Communication & Computation cho nhiều config t-of-n.
 *
 * Simulate toàn bộ Pedersen VSS DKG + FROST Schnorr signing locally (in-process),
 * không cần blockchain, database, hay browser.
 *
 * Usage:
 *   node scripts/experiment-tss-benchmark.js
 *   node scripts/experiment-tss-benchmark.js --output results.csv
 *   node scripts/experiment-tss-benchmark.js --n "3 5 7 9 11 15 21"   # BFT min per n
 *   node scripts/experiment-tss-benchmark.js --configs "2,3 3,5 5,9"  # explicit (t,n)
 *   node scripts/experiment-tss-benchmark.js --runs 3
 *
 * BFT minimum threshold: f = floor((n-1)/3), t_min = 2f+1
 *   n=3→t=1, n=5→t=3, n=7→t=5, n=9→t=5, n=11→t=7, n=15→t=9, n=21→t=13
 *
 * Output columns:
 *   config | phase | time_ms | msg_count | msg_bytes (estimated) | status
 */

import { performance } from 'perf_hooks';
import { randomBytes, createHash } from 'crypto';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { parseArgs } from 'util';
import EC_Module from 'elliptic';
import {
  generatePolynomial,
  computeCommitments,
  evaluatePolynomial,
  verifyShare,
  aggregateShares,
  computeSigningPublicKey,
  computeSigningPublicKeyFromCommitments,
  computeMasterPublicKey,
} from '../backend/src/crypto/pedersen-vss.js';

const ec = new EC_Module.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    output:  { type: 'string',  default: '' },
    configs: { type: 'string',  default: '' },
    n:       { type: 'string',  default: '' },  // list of n values → auto BFT threshold
    runs:    { type: 'string',  default: '1' },
    timeout: { type: 'string',  default: '600000' }, // 10 min
    append:  { type: 'boolean', default: false }, // append to existing file instead of overwrite
  },
  strict: false,
});

const NUM_RUNS    = Math.max(1, parseInt(args.runs)   || 1);
const TIMEOUT_MS  = parseInt(args.timeout) || 600_000;
const OUTPUT_FILE = args.output || '';

/**
 * BFT minimum threshold for n parties.
 * f = floor((n-1)/3) max Byzantine faults
 * t = 2f+1 minimum signers to ensure honest majority
 */
function bftMin(n) {
  const f = Math.floor((n - 1) / 3);
  return 2 * f + 1;
}

// Default configs: BFT minimum threshold for each n
const DEFAULT_N_VALUES = [3, 4, 5, 7, 9, 11, 13, 15, 19, 21, 25];
const DEFAULT_CONFIGS  = DEFAULT_N_VALUES.map(n => [bftMin(n), n]);

let CONFIGS;
if (args.configs) {
  // Explicit (t,n) pairs
  CONFIGS = args.configs.split(/\s+/).map(s => s.split(',').map(Number)).filter(([t, n]) => t > 0 && n >= t);
} else if (args.n) {
  // n values → auto BFT threshold
  CONFIGS = args.n.split(/[\s,]+/).map(Number).filter(n => n >= 3).map(n => [bftMin(n), n]);
} else {
  CONFIGS = DEFAULT_CONFIGS;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomScalar() {
  let s;
  do { s = BigInt('0x' + randomBytes(32).toString('hex')); }
  while (s === 0n || s >= ORDER);
  return s;
}

function scalarToHex(s) { return '0x' + s.toString(16).padStart(64, '0'); }

function generateRoles(n) {
  const roles = ['buyer', 'seller'];
  for (let i = 1; i <= n - 2; i++) roles.push(`mediator${i}`);
  return roles;
}

function generateRoleToId(n) {
  const map = { buyer: 1, seller: 2 };
  for (let i = 1; i <= n - 2; i++) map[`mediator${i}`] = i + 2;
  return map;
}

function estimateMsgBytes(obj) {
  return JSON.stringify(obj).length;
}

// ─── DKG Simulation ───────────────────────────────────────────────────────────

/**
 * Simulate full Pedersen VSS DKG for (t, n) config.
 * Returns per-phase metrics: { time_ms, msg_count, msg_bytes }.
 */
function runDKG(t, n) {
  const roles    = generateRoles(n);
  const roleToId = generateRoleToId(n);
  const metrics  = {};

  // Hoisted so each phase block can reference previous results
  const polynomials = {};
  const commitments = {};
  const shares      = {};  // shares[fromRole][toRole] = shareHex
  const finalShares = {};

  // ── B1: Polynomial generation + Feldman commitments ──────────────────────
  // Each party generates polynomial and broadcasts commitments to all others.
  // msg_count = n broadcasts (one per party).
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

    metrics.B1 = {
      time_ms:   +(performance.now() - t0).toFixed(3),
      msg_count: n,        // n broadcasts
      msg_bytes: totalBytes,
    };
  }

  // ── B2: Encrypted share distribution ──────────────────────────────────────
  // Each party i sends encrypted share to each party j ≠ i.
  // msg_count = n*(n-1) point-to-point messages.
  {
    const t0 = performance.now();
    let msgCount = 0;
    let totalBytes = 0;

    for (const fromRole of roles) {
      shares[fromRole] = {};
      for (const toRole of roles) {
        if (fromRole === toRole) continue;
        const toId = roleToId[toRole];
        const share = evaluatePolynomial(polynomials[fromRole], toId);
        shares[fromRole][toRole] = share;
        msgCount++;
        // Simulated ECDH-AES-GCM blob ~= 32 (iv) + 32 (share) + 16 (tag) + 65 (ephemeral pubkey)
        totalBytes += estimateMsgBytes({ fromRole, toRole, encryptedBlob: 'x'.repeat(145) });
      }
    }

    metrics.B2 = {
      time_ms:   +(performance.now() - t0).toFixed(3),
      msg_count: msgCount,   // n*(n-1)
      msg_bytes: totalBytes,
    };
  }

  // ── B3: Feldman verification + aggregation ────────────────────────────────
  // Each party j verifies all n-1 shares received and aggregates them.
  // Local computation only — no network messages.
  // msg_count = n*(n-1) verification operations.
  {
    const t0 = performance.now();
    let verifyOps = 0;

    for (const toRole of roles) {
      const toId = roleToId[toRole];
      const receivedShares = [];

      for (const fromRole of roles) {
        if (fromRole === toRole) continue;
        const share = shares[fromRole][toRole];
        const ok = verifyShare(share, commitments[fromRole], toId, t);
        if (!ok) throw new Error(`Feldman verify failed: ${fromRole}→${toRole}`);
        receivedShares.push(share);
        verifyOps++;
      }

      // Include self-share: f_j(j)
      const selfShare = evaluatePolynomial(polynomials[toRole], toId);
      receivedShares.push(selfShare);

      finalShares[toRole] = aggregateShares(receivedShares);
    }

    metrics.B3 = {
      time_ms:   +(performance.now() - t0).toFixed(3),
      msg_count: verifyOps,  // local verify ops (no network messages)
      msg_bytes: 0,          // local computation
    };
  }

  // ── B4: Signing pubkey derivation ─────────────────────────────────────────
  // Backend derives all Pⱼ from commitments (no party submission needed).
  // msg_count = 0 (backend-only computation).
  {
    const t0 = performance.now();
    const allComms = roles.map(r => commitments[r]);
    const masterPubKey = computeMasterPublicKey(allComms);
    const signingPubKeys = {};

    for (const role of roles) {
      const id = roleToId[role];
      signingPubKeys[role] = computeSigningPublicKeyFromCommitments(allComms, id, t);
    }

    metrics.B4 = {
      time_ms:   +(performance.now() - t0).toFixed(3),
      msg_count: 0,
      msg_bytes: 0,
    };
  }

  metrics._finalShares    = finalShares;
  metrics._commitments    = commitments;
  metrics._polynomials    = polynomials;
  metrics._roles          = roles;
  metrics._roleToId       = roleToId;
  metrics._signingPubKeys = (() => {
    const allComms = roles.map(r => commitments[r]);
    const pk = {};
    for (const role of roles) pk[role] = computeSigningPublicKeyFromCommitments(allComms, roleToId[role], t);
    return pk;
  })();

  return metrics;
}

// ─── Signing Simulation (FROST Schnorr) ───────────────────────────────────────

/**
 * Simulate FROST signing: nonce submission (R1) + z-share submission (R2).
 * Selects a threshold subset (first t parties).
 */
function runSigning(t, n, dkgResult) {
  const { _finalShares: finalShares, _roles: roles, _roleToId: roleToId, _signingPubKeys: signingPubKeys } = dkgResult;
  const metrics = {};

  // Select first t parties as signers
  const signerRoles = roles.slice(0, t);
  const signerIds   = signerRoles.map(r => roleToId[r]);

  const msgHash = '0x' + randomBytes(32).toString('hex');

  // ── Round 1: Nonce generation + submission ────────────────────────────────
  // Each signer generates (k1, k2) → (R1, R2) and submits to backend.
  // msg_count = t submissions.
  {
    const t0 = performance.now();
    const nonces = {};
    let totalBytes = 0;

    for (const role of signerRoles) {
      const k1 = randomScalar();
      const k2 = randomScalar();
      const R1 = ec.g.mul(k1.toString(16));
      const R2 = ec.g.mul(k2.toString(16));
      nonces[role] = { k1, k2, R1x: BigInt('0x' + R1.getX().toString(16)), R1y: BigInt('0x' + R1.getY().toString(16)), R2x: BigInt('0x' + R2.getX().toString(16)), R2y: BigInt('0x' + R2.getY().toString(16)) };
      totalBytes += estimateMsgBytes({ role, R1x: R1.getX().toString(16), R1y: R1.getY().toString(16), R2x: R2.getX().toString(16), R2y: R2.getY().toString(16) });
    }

    metrics.R1 = {
      time_ms:   +(performance.now() - t0).toFixed(3),
      msg_count: t,
      msg_bytes: totalBytes,
    };
    metrics._nonces = nonces;
  }

  // ── Round 2: z-share computation + submission ─────────────────────────────
  // Backend computes binding factors and effective nonces, then each signer submits z_i.
  // msg_count = t submissions + 1 broadcast of binding factors from backend.
  {
    const t0 = performance.now();
    const { _nonces: nonces } = metrics;

    // Compute Lagrange coefficients
    function lagrangeCoeff(xi, ids) {
      let num = 1n, den = 1n;
      for (const xj of ids) {
        if (xi === xj) continue;
        num = (num * (0n - BigInt(xj)) % ORDER + ORDER) % ORDER;
        const diff = (BigInt(xi) - BigInt(xj) + ORDER) % ORDER;
        den = den * diff % ORDER;
      }
      function modInv(a, m) {
        a = ((a % m) + m) % m;
        let [m0, x0, x1] = [m, 0n, 1n];
        while (a > 1n) { const q = a / m; [m, a] = [a % m, m]; [x0, x1] = [x1 - q * x0, x0]; }
        return (x1 + m0) % m0;
      }
      return num * modInv(den, ORDER) % ORDER;
    }

    const lambdas = {};
    for (const role of signerRoles) {
      lambdas[role] = lagrangeCoeff(roleToId[role], signerIds);
    }

    // Simulate binding factors (hash of signer set + msg + nonces)
    const bindingFactors = {};
    for (const role of signerRoles) {
      const input = `${role}${msgHash}${nonces[role].R1x}${nonces[role].R2x}`;
      bindingFactors[role] = BigInt('0x' + createHash('sha256').update(input).digest('hex')) % ORDER;
    }

    // Compute z-shares
    const zShares = [];
    let totalBytes = 0;

    for (const role of signerRoles) {
      const { k1, k2 } = nonces[role];
      const rho = bindingFactors[role];
      const share = BigInt('0x' + finalShares[role].replace(/^0x/, ''));
      const lambda = lambdas[role];

      // Simulate challenge e (normally H(R_agg, P_master, msg))
      const e = BigInt('0x' + createHash('sha256').update(msgHash + role).digest('hex')) % ORDER;

      // z_i = k1 + k2*ρ + e*λ*s_i  (mod ORDER)
      const z = (k1 + k2 * rho % ORDER + e * lambda % ORDER * share % ORDER) % ORDER;
      zShares.push({ role, z });
      totalBytes += estimateMsgBytes({ role, z: z.toString(16) });
    }

    metrics.R2 = {
      time_ms:   +(performance.now() - t0).toFixed(3),
      msg_count: t + 1,  // t z-share submissions + 1 binding factors broadcast
      msg_bytes: totalBytes,
    };
  }

  return metrics;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const results = [];

console.log(`\nTSS Benchmark — ${CONFIGS.length} configs × ${NUM_RUNS} run(s), timeout ${TIMEOUT_MS / 1000}s\n`);
console.log('config\t\tphase\ttime_ms\tmsg_count\tmsg_bytes\tstatus');
console.log('─'.repeat(80));

for (const [t, n] of CONFIGS) {
  const configLabel = `${t}-of-${n}`;
  let skipped = false;

  for (let run = 0; run < NUM_RUNS; run++) {
    let dkgResult;

    // ── DKG phases ──
    try {
      const dkgStart = performance.now();
      dkgResult = runDKG(t, n);
      const dkgTotal = performance.now() - dkgStart;

      if (dkgTotal > TIMEOUT_MS) {
        console.log(`${configLabel}\t\tDKG\t${dkgTotal.toFixed(0)}\t-\t-\tSKIPPED (>10min)`);
        results.push({ config: configLabel, run: run + 1, phase: 'DKG', time_ms: dkgTotal.toFixed(0), msg_count: '-', msg_bytes: '-', status: 'SKIPPED' });
        skipped = true;
        break;
      }

      for (const [phase, m] of Object.entries(dkgResult)) {
        if (phase.startsWith('_')) continue;
        const row = { config: configLabel, run: run + 1, phase, time_ms: m.time_ms, msg_count: m.msg_count, msg_bytes: m.msg_bytes, status: 'OK' };
        results.push(row);
        console.log(`${configLabel}\t\t${phase}\t${m.time_ms}\t${m.msg_count}\t\t${m.msg_bytes}\tOK`);
      }
    } catch (err) {
      console.error(`${configLabel} DKG ERROR:`, err.message);
      results.push({ config: configLabel, run: run + 1, phase: 'DKG', time_ms: 0, msg_count: 0, msg_bytes: 0, status: `ERROR: ${err.message}` });
      break;
    }

    if (skipped) break;

    // ── Signing phases ──
    try {
      const sigStart = performance.now();
      const sigResult = runSigning(t, n, dkgResult);
      const sigTotal  = performance.now() - sigStart;

      if (sigTotal > TIMEOUT_MS) {
        results.push({ config: configLabel, run: run + 1, phase: 'SIGN', time_ms: sigTotal.toFixed(0), msg_count: '-', msg_bytes: '-', status: 'SKIPPED (>10min)' });
        break;
      }

      for (const [phase, m] of Object.entries(sigResult)) {
        if (phase.startsWith('_')) continue;
        const row = { config: configLabel, run: run + 1, phase, time_ms: m.time_ms, msg_count: m.msg_count, msg_bytes: m.msg_bytes, status: 'OK' };
        results.push(row);
        console.log(`${configLabel}\t\t${phase}\t${m.time_ms}\t${m.msg_count}\t\t${m.msg_bytes}\tOK`);
      }
    } catch (err) {
      console.error(`${configLabel} SIGN ERROR:`, err.message);
      results.push({ config: configLabel, run: run + 1, phase: 'SIGN', time_ms: 0, msg_count: 0, msg_bytes: 0, status: `ERROR: ${err.message}` });
    }
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(80));
console.log(`Done. ${results.length} rows.\n`);

// ─── Build summary: avg per config+phase, then totals ────────────────────────

const summary = {};
for (const r of results) {
  const key = `${r.config}|${r.phase}`;
  if (!summary[key]) summary[key] = { config: r.config, phase: r.phase, times: [], msgs: [], bytes: [] };
  if (r.status === 'OK') {
    summary[key].times.push(+r.time_ms);
    summary[key].msgs.push(+r.msg_count);
    summary[key].bytes.push(+r.msg_bytes);
  }
}

// Total per config: sum of all phases averages
const configTotals = {};
for (const s of Object.values(summary)) {
  if (!configTotals[s.config]) configTotals[s.config] = { time: 0, msgs: 0, bytes: 0, ok: true };
  const avgTime  = s.times.length ? s.times.reduce((a, b) => a + b, 0) / s.times.length : null;
  const avgMsgs  = s.msgs.length  ? s.msgs.reduce((a, b) => a + b, 0)  / s.msgs.length  : null;
  const avgBytes = s.bytes.length ? s.bytes.reduce((a, b) => a + b, 0) / s.bytes.length : null;
  if (avgTime === null) { configTotals[s.config].ok = false; continue; }
  configTotals[s.config].time  += avgTime;
  configTotals[s.config].msgs  += avgMsgs  ?? 0;
  configTotals[s.config].bytes += avgBytes ?? 0;
}

if (OUTPUT_FILE) {
  const header = 'config,run,phase,time_ms,msg_count,msg_bytes,status\n';
  const csv = results.map(r => `${r.config},${r.run},${r.phase},${r.time_ms},${r.msg_count},${r.msg_bytes},${r.status}`).join('\n');
  // Append total rows (avg over runs)
  const totalLines = Object.entries(configTotals).map(([cfg, t]) =>
    `${cfg},-,TOTAL,${t.ok ? t.time.toFixed(3) : 'N/A'},${t.ok ? t.msgs.toFixed(0) : 'N/A'},${t.ok ? t.bytes.toFixed(0) : 'N/A'},${t.ok ? 'OK' : 'PARTIAL'}`
  ).join('\n');

  const APPEND = args.append;
  const fileExists = existsSync(OUTPUT_FILE);
  let content;

  if (APPEND && fileExists) {
    // Append mode: skip header, just add data rows + total rows
    content = '\n' + csv + '\n' + totalLines;
    const existing = readFileSync(OUTPUT_FILE, 'utf-8');
    writeFileSync(OUTPUT_FILE, existing + content);
    console.log(`Results appended to ${OUTPUT_FILE}`);
  } else {
    // Overwrite mode: write full file with header
    content = header + csv + '\n' + totalLines;
    writeFileSync(OUTPUT_FILE, content);
    console.log(`Results saved to ${OUTPUT_FILE}`);
  }
}

// Always print summary
console.log('\nSummary (avg over runs):');
console.log('config\t\tphase\t\tavg_time_ms\tavg_msg_count\tavg_msg_bytes');
let lastConfig = null;
for (const s of Object.values(summary)) {
  if (lastConfig && lastConfig !== s.config) {
    // Print total for previous config
    const tot = configTotals[lastConfig];
    if (tot) {
      const tv = tot.ok ? tot.time.toFixed(2) : 'N/A';
      const tm = tot.ok ? tot.msgs.toFixed(0) : 'N/A';
      const tb = tot.ok ? tot.bytes.toFixed(0) : 'N/A';
      console.log(`${lastConfig}\t\tTOTAL\t\t${tv}\t\t${tm}\t\t${tb}`);
    }
    console.log('');
  }
  const avgTime  = s.times.length ? (s.times.reduce((a, b) => a + b, 0) / s.times.length).toFixed(2) : 'N/A';
  const avgMsg   = s.msgs.length  ? (s.msgs.reduce((a, b) => a + b, 0)  / s.msgs.length).toFixed(1)  : 'N/A';
  const avgBytes = s.bytes.length ? (s.bytes.reduce((a, b) => a + b, 0) / s.bytes.length).toFixed(0) : 'N/A';
  console.log(`${s.config}\t\t${s.phase}\t\t${avgTime}\t\t${avgMsg}\t\t${avgBytes}`);
  lastConfig = s.config;
}
// Print total for last config
if (lastConfig && configTotals[lastConfig]) {
  const tot = configTotals[lastConfig];
  const tv = tot.ok ? tot.time.toFixed(2) : 'N/A';
  const tm = tot.ok ? tot.msgs.toFixed(0) : 'N/A';
  const tb = tot.ok ? tot.bytes.toFixed(0) : 'N/A';
  console.log(`${lastConfig}\t\tTOTAL\t\t${tv}\t\t${tm}\t\t${tb}`);
}

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
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { parseArgs } from 'util';
import { runDKG, runSigning, bftMin } from './lib/tss-simulation.js';

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

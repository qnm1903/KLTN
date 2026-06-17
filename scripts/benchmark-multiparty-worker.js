/**
 * TSS Multi-Party Benchmark — Worker Threads
 *
 * n Worker threads (1 thread = 1 party) chạy song song thực sự.
 * Main thread = coordinator / message bus.
 * Đo wall-clock DKG thực tế, so sánh với max_party_ms từ benchmark-party-compute.js.
 *
 * Usage:
 *   node benchmark-multiparty-worker.js
 *   node benchmark-multiparty-worker.js --rtt 0,50,100    # sweep RTT values (ms)
 *   node benchmark-multiparty-worker.js --configs "3,5 5,7 9,15"
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseArgs } from 'util';
import {
  generatePolynomial, computeCommitments, evaluatePolynomial,
  verifyShare, aggregateShares,
} from '../backend/src/crypto/pedersen-vss.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const hrNow  = () => process.hrtime.bigint();
const toMs   = ns => Number(ns) / 1_000_000;
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// ── Worker (Party) ─────────────────────────────────────────────────────────────
// Mỗi worker = 1 party trong DKG. Trao đổi với main thread qua postMessage.

if (!isMainThread) {
  const { t, n, myId, allIds } = workerData;

  // Chờ message có type cụ thể từ coordinator
  const waitFor = type => new Promise(resolve => {
    const h = msg => { if (msg.type === type) { parentPort.off('message', h); resolve(msg); } };
    parentPort.on('message', h);
  });

  parentPort.postMessage({ type: 'READY', id: myId });
  const { warmupRounds } = await waitFor('WARMUP');

  // Warmup: JIT compile + warm CPU cache trước khi đo thực
  for (let i = 0; i < warmupRounds; i++) {
    const { coeffs: wc } = generatePolynomial(t);
    const wComm = computeCommitments(wc);
    for (const id of allIds) if (id !== myId) evaluatePolynomial(wc, id);
    const ws = allIds.map(id => evaluatePolynomial(wc, id));
    for (const id of allIds) if (id !== myId) verifyShare(ws[id - 1], wComm, myId, t);
    aggregateShares(ws);
  }
  parentPort.postMessage({ type: 'WARMUP_DONE', id: myId });
  await waitFor('START');

  // B1: sinh polynomial + Feldman commitments → broadcast
  let t0 = hrNow();
  const { coeffs } = generatePolynomial(t);
  const myCommitments = computeCommitments(coeffs);
  parentPort.postMessage({ type: 'B1_DONE', id: myId, commitments: myCommitments, ms: toMs(hrNow() - t0) });

  // Nhận tất cả commitments từ n parties
  const { allCommitments } = await waitFor('B1_BROADCAST');

  // B2: tính f_i(j) cho tất cả j ≠ i → gửi cho coordinator để route
  t0 = hrNow();
  const outShares = {};
  for (const id of allIds) if (id !== myId) outShares[id] = evaluatePolynomial(coeffs, id);
  parentPort.postMessage({ type: 'B2_DONE', id: myId, shares: outShares, ms: toMs(hrNow() - t0) });

  // Nhận n-1 shares gửi đến mình
  const { inShares } = await waitFor('B2_SHARES');

  // B3: xác minh + tổng hợp
  t0 = hrNow();
  for (const fromId of allIds) {
    if (fromId === myId) continue;
    verifyShare(inShares[fromId], allCommitments[fromId], myId, t);
  }
  const selfShare = evaluatePolynomial(coeffs, myId);
  aggregateShares(allIds.map(id => id === myId ? selfShare : inShares[id]));
  parentPort.postMessage({ type: 'B3_DONE', id: myId, ms: toMs(hrNow() - t0) });
}

// ── Main (Coordinator) ─────────────────────────────────────────────────────────

else {
  const { values: args } = parseArgs({
    options: {
      rtt:     { type: 'string', default: '0' },
      configs: { type: 'string', default: '' },
    },
    strict: false,
  });

  const CONFIGS = args.configs
    ? args.configs.split(/\s+/).map(s => { const [t, n] = s.split(',').map(Number); return { t, n }; })
    : [
        { t: 3,  n: 5  }, { t: 5,  n: 7  }, { t: 7,  n: 11 },
        { t: 9,  n: 15 }, { t: 13, n: 21 }, { t: 17, n: 25 },
        { t: 21, n: 31 }, { t: 27, n: 40 }, { t: 37, n: 55 },
      ];

  const RTT_VALUES = args.rtt.split(',').map(Number);

  async function runConfig(t, n, simRTT) {
    const allIds    = Array.from({ length: n }, (_, i) => i + 1);
    const oneWay    = simRTT / 2;  // propagation delay một chiều
    const workers   = new Map();
    const bus       = new EventEmitter();
    bus.setMaxListeners(500);

    for (const id of allIds) {
      const w = new Worker(__filename, { workerData: { t, n, myId: id, allIds } });
      w.on('message', msg => bus.emit(msg.type, msg));
      w.on('error', err => { throw err; });
      workers.set(id, w);
    }

    // Chờ n messages có type chỉ định
    const waitN = (type, count) => new Promise(resolve => {
      const results = [];
      bus.on(type, function h(msg) {
        results.push(msg);
        if (results.length === count) { bus.off(type, h); resolve(results); }
      });
    });

    // Chờ tất cả workers sẵn sàng, warmup JIT, rồi mới bắt đầu đo
    // Warmup ít hơn với n lớn (verifyShare đắt, warmup quá 1 lần là đủ)
    const warmupRounds = n <= 15 ? 3 : n <= 25 ? 2 : 1;
    await waitN('READY', n);
    for (const [, w] of workers) w.postMessage({ type: 'WARMUP', warmupRounds });
    await waitN('WARMUP_DONE', n);

    const t_start = hrNow();
    for (const [, w] of workers) w.postMessage({ type: 'START' });

    // B1: mỗi party broadcast commitments
    const b1Msgs = await waitN('B1_DONE', n);
    const allCommitments = {};
    for (const m of b1Msgs) allCommitments[m.id] = m.commitments;

    if (oneWay > 0) await sleep(oneWay);  // simulate broadcast propagation
    for (const [, w] of workers) w.postMessage({ type: 'B1_BROADCAST', allCommitments });

    // B2: mỗi party gửi n-1 shares
    const b2Msgs = await waitN('B2_DONE', n);
    const pendingShares = new Map(allIds.map(id => [id, {}]));
    for (const m of b2Msgs) {
      for (const [toId, share] of Object.entries(m.shares)) {
        pendingShares.get(Number(toId))[m.id] = share;
      }
    }

    if (oneWay > 0) await sleep(oneWay);  // simulate share delivery
    for (const id of allIds) {
      workers.get(id).postMessage({ type: 'B2_SHARES', inShares: pendingShares.get(id) });
    }

    // B3: mỗi party verify + aggregate
    await waitN('B3_DONE', n);
    const wallMs = toMs(hrNow() - t_start);

    for (const [, w] of workers) await w.terminate();

    const netMs     = oneWay * 2;  // 2 inter-phase delays: B1→B2 và B2→B3
    const computeMs = wallMs - netMs;
    const msgCount  = n + n * (n - 1) + n * (n - 1);  // B1 + B2 + B3
    return { wallMs, computeMs, netMs, msgCount };
  }

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const csvRows = ['config,simRTT_ms,wall_ms,compute_ms,net_ms,msg_count'];

  console.log('\nTSS Multi-Party Worker Benchmark (n threads running in parallel)');
  console.log('config         RTT(ms)  wall(ms)  compute(ms)  msgs');
  console.log('─'.repeat(56));

  for (const { t, n } of CONFIGS) {
    const cfg = `${t}-of-${n}`;
    for (const rtt of RTT_VALUES) {
      process.stdout.write(`  ${cfg} rtt=${rtt}ms... `);
      try {
        const r = await runConfig(t, n, rtt);
        console.log(`wall=${r.wallMs.toFixed(0)}ms compute=${r.computeMs.toFixed(0)}ms`);
        csvRows.push([cfg, rtt, r.wallMs.toFixed(1), r.computeMs.toFixed(1), r.netMs.toFixed(1), r.msgCount].join(','));
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        csvRows.push([cfg, rtt, 'ERROR', '', '', ''].join(','));
      }
    }
  }

  const outPath = join(__dirname, `../experiments/multiparty-wall-${date}.csv`);
  writeFileSync(outPath, csvRows.join('\n') + '\n');
  console.log(`\nOutput: ${outPath}`);
}

/**
 * TSS Completion Throughput & Saturation — đo số chữ ký TSS HOÀN TẤT mỗi giây của
 * aggregator ở tầng crypto (in-process, KHÔNG cần server/DB/blockchain).
 *
 * Vì sao đo ở tầng crypto thay vì HTTP/k6:
 *   Endpoint /sign yêu cầu JWT + khớp địa chỉ ví + round2Context hợp lệ + verify z-share
 *   theo DKG → không thể giả lập "completion thật" bằng dữ liệu random qua k6.
 *   Tầng crypto cô lập đúng nút cổ chai thật của aggregator: EC math (CPU-bound).
 *
 * Định nghĩa 1 "completion" = 1 vòng ký FROST đầy đủ (Round 1 nonce + Round 2 z-aggregation)
 * cho 1 subset t-of-n. KHÔNG tính:
 *   - DKG  → chỉ chạy 1 lần lúc setup (không phải hot-path).
 *   - On-chain confirmation → nút cổ chai riêng (~12s/block Ethereum), tách bạch trong báo cáo.
 *
 * Quét song song qua worker_threads để tìm ĐIỂM BÃO HÒA: throughput tăng theo số worker
 * rồi chững lại khi vượt số core CPU vật lý → đó là trần năng lực off-chain.
 *
 * Usage:
 *   node scripts/experiment-throughput.js
 *   node scripts/experiment-throughput.js --config 5,7 --workers "1 2 4 8 12" --duration 5000
 *   node scripts/experiment-throughput.js --config 5,7 --output experiments/throughput-260614.csv
 */

import { Worker, isMainThread, workerData, parentPort } from 'worker_threads';
import { performance } from 'perf_hooks';
import os from 'os';
import { writeFileSync } from 'fs';
import { parseArgs } from 'util';
import { runDKG, runSigning } from './lib/tss-simulation.js';

// ─── Worker: ký liên tục trong `durationMs`, đếm số completion ───────────────────
if (!isMainThread) {
  const { t, n, durationMs, warmupMs } = workerData;
  const dkg = runDKG(t, n);                 // setup 1 lần — KHÔNG tính vào throughput

  // Warmup để JIT ổn định (loại cold-start làm sai lệch số đo)
  const warmEnd = performance.now() + warmupMs;
  while (performance.now() < warmEnd) runSigning(t, n, dkg);

  let ops = 0, sumLat = 0, minLat = Infinity, maxLat = 0;
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    const s = performance.now();
    runSigning(t, n, dkg);
    const lat = performance.now() - s;
    ops++; sumLat += lat;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  parentPort.postMessage({ ops, sumLat, minLat: minLat === Infinity ? 0 : minLat, maxLat });
}

// ─── Main: parse args, quét số worker, tổng hợp throughput ───────────────────────
else {
  const { values: args } = parseArgs({
    options: {
      config:   { type: 'string', default: '5,7' },  // (t,n) — mặc định production 5-of-7
      workers:  { type: 'string', default: '' },      // ví dụ "1 2 4 8"; rỗng → auto theo số core
      duration: { type: 'string', default: '5000' },  // ms đo mỗi mức worker
      warmup:   { type: 'string', default: '800' },   // ms warmup mỗi worker
      output:   { type: 'string', default: '' },
    },
    strict: false,
  });

  const [t, n] = args.config.split(',').map(Number);
  if (!(t > 0 && n >= t)) { console.error(`Config không hợp lệ: ${args.config} (cần t>0, n>=t)`); process.exit(1); }
  const durationMs = parseInt(args.duration) || 5000;
  const warmupMs   = parseInt(args.warmup)   || 800;
  const cores      = os.cpus().length;

  const dedupeSorted = (a) => [...new Set(a)].filter((x) => x > 0).sort((x, y) => x - y);
  const workerList = args.workers
    ? dedupeSorted(args.workers.split(/[\s,]+/).map(Number))
    : dedupeSorted([1, 2, Math.max(2, Math.floor(cores / 2)), cores, cores * 2]);

  const runLevel = (workerCount) => new Promise((resolve, reject) => {
    const results = [];
    let done = 0;
    for (let i = 0; i < workerCount; i++) {
      // --no-warnings: chặn MODULE_TYPELESS_PACKAGE_JSON khi worker reload file .js (root
      // package.json không đặt "type":"module" vì hardhat.config.js dùng CommonJS).
      const w = new Worker(new URL(import.meta.url), { workerData: { t, n, durationMs, warmupMs }, execArgv: ['--no-warnings'] });
      w.on('message', (m) => { results.push(m); if (++done === workerCount) resolve(results); });
      w.on('error', reject);
    }
  });

  console.log(`\nTSS Completion Throughput — config ${t}-of-${n} | CPU ${cores} core | đo ${durationMs}ms/mức, warmup ${warmupMs}ms`);
  console.log(`1 completion = 1 vòng FROST đầy đủ (R1+R2). DKG & on-chain KHÔNG tính.\n`);
  console.log('workers\tcompleted\tthroughput(sig/s)\tavg_lat(ms)\tmin\tmax');
  console.log('─'.repeat(76));

  const rows = [];
  for (const wc of workerList) {
    const results = await runLevel(wc);
    const totalOps = results.reduce((a, b) => a + b.ops, 0);
    const sumLat   = results.reduce((a, b) => a + b.sumLat, 0);
    const avgLat   = totalOps ? sumLat / totalOps : 0;
    const minLat   = Math.min(...results.map((r) => r.minLat));
    const maxLat   = Math.max(...results.map((r) => r.maxLat));
    // Mỗi worker chạy ~durationMs đồng thời → throughput = tổng completion / duration
    const tput = totalOps / (durationMs / 1000);
    rows.push({ wc, totalOps, tput, avgLat, minLat, maxLat });
    console.log(`${wc}\t${totalOps}\t\t${tput.toFixed(1)}\t\t\t${avgLat.toFixed(3)}\t${minLat.toFixed(3)}\t${maxLat.toFixed(3)}`);
  }

  const peak = rows.reduce((a, b) => (b.tput > a.tput ? b : a), rows[0]);
  console.log('─'.repeat(76));
  console.log(`\nĐiểm bão hòa: ~${peak.tput.toFixed(1)} sig/s tại ${peak.wc} worker(s) trên CPU ${cores} core.`);
  console.log(`Vượt mức này throughput không tăng đáng kể → bão hòa CPU (EC math là nút cổ chai).\n`);

  if (args.output) {
    const header = 'config,cpu_cores,workers,duration_ms,completed,throughput_sig_per_s,avg_lat_ms,min_lat_ms,max_lat_ms\n';
    const csv = rows.map((r) =>
      `${t}-of-${n},${cores},${r.wc},${durationMs},${r.totalOps},${r.tput.toFixed(2)},${r.avgLat.toFixed(3)},${r.minLat.toFixed(3)},${r.maxLat.toFixed(3)}`
    ).join('\n');
    writeFileSync(args.output, header + csv + '\n');
    console.log(`Đã lưu → ${args.output}`);
  }
}

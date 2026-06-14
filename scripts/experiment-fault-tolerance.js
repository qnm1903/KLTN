/**
 * Fault Tolerance / Liveness — đo dung sai lỗi của TSS escrow: bao nhiêu bên có thể
 * offline/drop mà hệ vẫn ký được, và phơi bày SPOF của core party (buyer/seller).
 *
 * Cơ sở từ code thật:
 *   - Ngưỡng BFT t=2f+1, f=⌊(n-1)/3⌋ (tss-simulation.bftMin).
 *   - Lagrange tái dựng đúng với MỌI t-subset → mediator có thể thay thế lẫn nhau.
 *   - validateSignerBitmap (routes/escrow.js): lane RELEASE bắt buộc CẢ buyer & seller ký
 *     (dispute mới nới còn ≥1 core) → buyer/seller là điểm lỗi đơn cho release.
 *
 * Hai kịch bản (Monte Carlo M lần/điểm):
 *   mediator_only  — lỗi chỉ rơi vào mediator (core luôn online): best case, dung sai = n−t.
 *   random_release — lỗi rơi ngẫu nhiên mọi bên; release cần đủ t VÀ cả 2 core còn sống.
 *
 * Kèm kiểm thử liveness THỰC: ký bằng 1 t-subset sống sót tối thiểu → xác nhận tạo được
 * chữ ký hợp lệ (không chỉ tổ hợp lý thuyết).
 *
 * Usage:
 *   node scripts/experiment-fault-tolerance.js
 *   node scripts/experiment-fault-tolerance.js --n "3 5 7 11 15 21" --trials 3000 --output experiments/fault-tolerance.csv
 */

import { writeFileSync } from 'fs';
import { parseArgs } from 'util';
import { runDKG, runSigning, generateRoles, bftMin } from './lib/tss-simulation.js';

const { values: args } = parseArgs({
  options: {
    n:      { type: 'string', default: '3 5 7 11 15 21' },
    trials: { type: 'string', default: '3000' },
    output: { type: 'string', default: '' },
  },
  strict: false,
});

const TRIALS = Math.max(100, parseInt(args.trials) || 3000);
const CONFIGS = args.n.split(/[\s,]+/).map(Number).filter((x) => x >= 3).map((n) => [bftMin(n), n]);

/** Chọn ngẫu nhiên k phần tử phân biệt từ arr (Fisher–Yates một phần). */
function pick(arr, k) {
  const a = [...arr];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/** Tỉ lệ thành công khi k bên lỗi, theo kịch bản. release: cần đủ t + cả 2 core sống. */
function successRate(k, scenario, t, roles) {
  const mediators = roles.filter((r) => r.startsWith('mediator'));
  const pool = scenario === 'mediator_only' ? mediators : roles;
  if (k > pool.length) return null; // không áp dụng
  let ok = 0;
  for (let i = 0; i < TRIALS; i++) {
    const dropped = new Set(pick(pool, k));
    const survivors = roles.filter((r) => !dropped.has(r));
    const enough = survivors.length >= t;
    const coreAlive = survivors.includes('buyer') && survivors.includes('seller');
    if (enough && coreAlive) ok++;
  }
  return ok / TRIALS;
}

/** Kiểm thử liveness thực: ký bằng 1 t-subset sống sót tối thiểu (buyer+seller+t-2 mediator). */
function livenessCheck(t, n, dkg, roles) {
  const mediators = roles.filter((r) => r.startsWith('mediator'));
  const subset = ['buyer', 'seller', ...mediators.slice(0, t - 2)];
  try {
    runSigning(t, n, dkg, subset);
    return true;
  } catch {
    return false;
  }
}

console.log(`\nFault Tolerance / Liveness — ${CONFIGS.length} config × ${TRIALS} trials/điểm\n`);
const rows = [];
for (const [t, n] of CONFIGS) {
  const roles = generateRoles(n);
  const dkg = runDKG(t, n);
  const f = Math.floor((n - 1) / 3);
  const crashTol = n - t;                       // dung sai crash (lỗi tránh core)
  const live = livenessCheck(t, n, dkg, roles); // ký thật bằng subset sống sót tối thiểu

  console.log(`── ${t}-of-${n} ──  f(Byzantine)=${f} | dung sai crash (best case)=${crashTol} | liveness subset OK=${live}`);
  for (const scenario of ['mediator_only', 'random_release']) {
    const maxK = scenario === 'mediator_only' ? n - 2 : n;
    const line = [];
    for (let k = 0; k <= maxK; k++) {
      const rate = successRate(k, scenario, t, roles);
      if (rate === null) continue;
      rows.push({ config: `${t}-of-${n}`, scenario, k, rate });
      line.push(`k=${k}:${(rate * 100).toFixed(0)}%`);
    }
    console.log(`   ${scenario.padEnd(15)} ${line.join('  ')}`);
  }
  console.log('');
  rows.push({ config: `${t}-of-${n}`, scenario: 'meta', k: -1, rate: null, f, crashTol, live });
}

if (args.output) {
  const header = 'config,scenario,k,success_rate,f_byzantine,crash_tolerance,liveness_ok\n';
  const lines = rows.map((r) =>
    r.scenario === 'meta'
      ? `${r.config},meta,,,${r.f},${r.crashTol},${r.live}`
      : `${r.config},${r.scenario},${r.k},${r.rate.toFixed(4)},,,`
  );
  writeFileSync(args.output, header + lines.join('\n') + '\n');
  console.log(`Đã lưu → ${args.output}`);
}

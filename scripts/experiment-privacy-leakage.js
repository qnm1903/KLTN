/**
 * Privacy Leakage Experiment — định lượng thông tin một observer on-chain suy ra được
 * cho mỗi lần giải ngân, so sánh TSS (EscrowVault) vs MultiSig (MultiSigEscrow).
 *
 * Mô hình tấn công: observer ngoài đọc toàn bộ giao dịch + nhật ký sự kiện công khai.
 *
 * Vector rò rỉ được SUY RA TRỰC TIẾP từ schema calldata/event của hai contract thật:
 *
 *   EscrowVault.release(rAddr, z, e, msgHash, signerBitmap)
 *     → 1 giao dịch, 1 chữ ký Schnorr tổng hợp (rAddr,z,e) — kích thước cố định,
 *       không phân biệt được với chữ ký đơn; submitter (msg.sender) KHÔNG bị ràng buộc
 *       vào tập ký nên có thể là relayer bất kỳ.
 *     → event FundsReleased(escrowId, recipient, signerBitmap, action): chỉ lộ tập vai trò
 *       (bitmap), không lộ khóa/chữ ký/thời điểm của từng bên.
 *
 *   MultiSigEscrow.signRelease()  (gọi t lần, mỗi bên một giao dịch onlyParties)
 *     → t giao dịch ECDSA riêng, mỗi cái có msg.sender = địa chỉ người ký
 *     → t event Signed(escrowId, signer, action): lộ địa chỉ + thứ tự + thời điểm từng bên
 *     → t địa chỉ cùng ký một escrow ⇒ đồ thị liên kết co-signing với C(t,2) cạnh
 *
 * Output: ../experiments/privacy-leakage-{date}.csv
 *
 * Chạy: node scripts/experiment-privacy-leakage.js
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cùng dải cấu hình với các thực nghiệm khác để thấy xu hướng theo t-of-n
const CONFIGS = [
  { t: 3,  n: 5  },
  { t: 5,  n: 7  },   // production default
  { t: 7,  n: 11 },
  { t: 9,  n: 15 },
  { t: 13, n: 21 },
  { t: 17, n: 25 },
  { t: 21, n: 31 },
  { t: 27, n: 40 },
  { t: 37, n: 55 },
];

// Số cạnh liên kết địa chỉ trong đồ thị co-signing: mọi cặp trong t người ký bị
// liên kết vì cùng ký một escrow ⇒ C(t,2) = t(t-1)/2.
const coSigningEdges = (t) => (t * (t - 1)) / 2;

// log2(C(n,t)) — số bit thông tin về việc TẬP CON nào trong n bên đã ký.
// Cả hai mô hình đều lộ thông tin này (TSS qua signerBitmap, MultiSig qua t địa chỉ),
// nên đây KHÔNG phải ưu thế của TSS — đưa vào để trung thực về giới hạn.
function roleSubsetBits(t, n) {
  // log2( C(n,t) ) = sum_{k=1..t} log2((n-k+1)/k)
  let bits = 0;
  for (let k = 1; k <= t; k++) bits += Math.log2((n - k + 1) / k);
  return bits;
}

// Vector rò rỉ cho một lần giải ngân theo từng mô hình.
function leakageTSS(t, n) {
  return {
    txns:                  1,   // 1 giao dịch release duy nhất
    individual_sigs:       0,   // chữ ký tổng hợp, không tách thành chữ ký cá nhân
    signer_events:         0,   // FundsReleased không gắn người ký cụ thể
    distinct_signer_addrs: 0,   // calldata không chứa địa chỉ người ký
    assoc_edges:           0,   // không có đồ thị co-signing
    timing_samples:        0,   // không lộ thời điểm ký của từng bên
    order_revealed:        0,   // không lộ thứ tự ký
    submitter_unlinkable:  1,   // người nộp tách rời tập người ký
    role_subset_bits:      roleSubsetBits(t, n), // lộ qua signerBitmap (giới hạn có chủ ý)
  };
}

function leakageMultiSig(t, n) {
  return {
    txns:                  t,            // mỗi bên một giao dịch signRelease
    individual_sigs:       t,            // t chữ ký ECDSA tách biệt
    signer_events:         t,            // t event Signed kèm địa chỉ
    distinct_signer_addrs: t,            // t msg.sender phân biệt
    assoc_edges:           coSigningEdges(t), // đồ thị liên kết C(t,2)
    timing_samples:        t,            // t block timestamp
    order_revealed:        1,            // lộ thứ tự ký
    submitter_unlinkable:  0,            // submitter == người ký
    role_subset_bits:      roleSubsetBits(t, n), // lộ qua chính các địa chỉ ký
  };
}

function main() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const cols = [
    'config', 'scheme', 'txns', 'individual_sigs', 'signer_events',
    'distinct_signer_addrs', 'assoc_edges', 'timing_samples',
    'order_revealed', 'submitter_unlinkable', 'role_subset_bits',
  ];
  const rows = [cols.join(',')];

  console.log('\nPrivacy Leakage Experiment — thông tin observer suy ra / lần giải ngân');
  console.log('Cfg         scheme    txns sigs events addrs edges timing  roleBits');
  console.log('─'.repeat(74));

  for (const { t, n } of CONFIGS) {
    const cfg = `${t}-of-${n}`;
    for (const [scheme, lk] of [['TSS', leakageTSS(t, n)], ['MultiSig', leakageMultiSig(t, n)]]) {
      rows.push([
        cfg, scheme, lk.txns, lk.individual_sigs, lk.signer_events,
        lk.distinct_signer_addrs, lk.assoc_edges, lk.timing_samples,
        lk.order_revealed, lk.submitter_unlinkable, lk.role_subset_bits.toFixed(2),
      ].join(','));
      console.log(
        `${cfg.padEnd(11)} ${scheme.padEnd(9)} ${String(lk.txns).padStart(3)}  ` +
        `${String(lk.individual_sigs).padStart(4)}  ${String(lk.signer_events).padStart(5)}  ` +
        `${String(lk.distinct_signer_addrs).padStart(4)}  ${String(lk.assoc_edges).padStart(4)}  ` +
        `${String(lk.timing_samples).padStart(5)}   ${lk.role_subset_bits.toFixed(2).padStart(6)}`
      );
    }
  }

  const outPath = join(__dirname, `../experiments/privacy-leakage-${date}.csv`);
  writeFileSync(outPath, rows.join('\n') + '\n');
  console.log(`\nOutput: ${outPath}`);

  // Tóm tắt ưu thế ở cấu hình production 5-of-7
  const ms = leakageMultiSig(5, 7), tss = leakageTSS(5, 7);
  console.log(`\n5-of-7: MultiSig lộ ${ms.individual_sigs} chữ ký, ${ms.assoc_edges} cạnh liên kết, ` +
    `${ms.timing_samples} mẫu thời điểm; TSS lộ 0 cả ba.`);
  console.log(`Cả hai cùng lộ ~${tss.role_subset_bits.toFixed(1)} bit về tập vai trò đã ký (TSS không thắng ở mục này).`);
}

main();

const fs = require('fs');
const path = require('path');

const GAS_RESULTS_PATH = path.join(__dirname, '..', 'gas_results.json');

function toNumber(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function averageFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const nums = entries
    .map((item) => toNumber(item?.gasUsed, NaN))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function formatK(value) {
  return `${Math.round(value / 1000)}k`;
}

function main() {
  if (!fs.existsSync(GAS_RESULTS_PATH)) {
    throw new Error(`gas_results.json not found at ${GAS_RESULTS_PATH}`);
  }

  const data = JSON.parse(fs.readFileSync(GAS_RESULTS_PATH, 'utf8'));

  if (!data.tss_escrow_vault) data.tss_escrow_vault = {};
  if (!data.multisig_escrow) data.multisig_escrow = {};
  if (!data.comparative_analysis) data.comparative_analysis = {};
  if (!data.storage_and_payload_metrics) data.storage_and_payload_metrics = {};
  if (!data.storage_and_payload_metrics.contract_size_bytes) {
    data.storage_and_payload_metrics.contract_size_bytes = {};
  }
  if (!data.storage_and_payload_metrics.calldata_payload_size_bytes) {
    data.storage_and_payload_metrics.calldata_payload_size_bytes = {};
  }

  const avgRelease = averageFromEntries(data.tss?.release);
  const avgRefund = averageFromEntries(data.tss?.refund);
  const avgTimeout = averageFromEntries(data.tss?.timeout);

  if (avgRelease !== null) data.tss_escrow_vault.release = avgRelease;
  if (avgRefund !== null) data.tss_escrow_vault.refund = avgRefund;
  if (avgTimeout !== null) data.tss_escrow_vault.timeoutRelease = avgTimeout;

  const tssLock = toNumber(data.tss_escrow_vault.lockFunds, 0);
  const tssRelease = toNumber(data.tss_escrow_vault.release, 0);
  const msLock = toNumber(data.multisig_escrow.lockFunds, 0);
  const msSignRelease = toNumber(data.multisig_escrow['signRelease (average per signature)'], 0);

  const happyTss = tssLock + tssRelease;
  const happyMulti = msLock + 2 * msSignRelease;
  const savingsPct = happyMulti > 0
    ? (((happyMulti - happyTss) / happyMulti) * 100).toFixed(1)
    : '0.0';

  data.comparative_analysis.happy_path_tss = `Tóm tắt: lockFunds (${formatK(tssLock)}) + release (${formatK(tssRelease)}) = ${formatK(happyTss)} gas`;
  data.comparative_analysis.happy_path_multisig = `Tóm tắt: lockFunds (${formatK(msLock)}) + 2 * signRelease (~${formatK(msSignRelease)}) = ${formatK(happyMulti)} gas`;
  data.comparative_analysis.conclusion = `TSS tiết kiệm khoảng ${savingsPct}% lượng gas on-chain trong happy path nhờ hợp nhất chữ ký off-chain.`;

  const sizeTss = toNumber(data.storage_and_payload_metrics.contract_size_bytes.EscrowVault_TSS, 0);
  const sizeMulti = toNumber(data.storage_and_payload_metrics.contract_size_bytes.MultiSigEscrow, 0);
  const payloadTss = toNumber(data.storage_and_payload_metrics.calldata_payload_size_bytes.tss_release_tx, 0);
  const payloadMulti = toNumber(data.storage_and_payload_metrics.calldata_payload_size_bytes.multisig_release_2_txs_combined, 0);

  const sizeDelta = Math.abs(sizeTss - sizeMulti);
  const sizeLabel = sizeTss <= sizeMulti ? 'nhẹ hơn' : 'nặng hơn';

  data.storage_and_payload_metrics.storage_conclusion = `EscrowVault (TSS) ${sizeLabel} ${sizeDelta} bytes về Contract Size. Về payload release: Multi-sig (2 tx) = ${payloadMulti} bytes, TSS (1 tx) = ${payloadTss} bytes; dù calldata lớn hơn, TSS vẫn thường rẻ gas hơn do tránh giao dịch thứ 2.`;

  fs.writeFileSync(GAS_RESULTS_PATH, JSON.stringify(data, null, 2));

  console.log('Synced gas_results.json');
  console.log(`- tss_escrow_vault.release = ${data.tss_escrow_vault.release}`);
  console.log(`- tss_escrow_vault.refund = ${data.tss_escrow_vault.refund}`);
  console.log(`- tss_escrow_vault.timeoutRelease = ${data.tss_escrow_vault.timeoutRelease}`);
  console.log(`- ${data.comparative_analysis.conclusion}`);
}

main();
/**
 * timeout-part2-trigger.js
 *
 * Bước 2/2 cho kịch bản Quá hạn trên Sepolia.
 * Đọc thông tin vault từ deployments/pending-timeout.json rồi gọi triggerTimeout().
 * Chạy sau >= 24 giờ kể từ khi chạy timeout-part1-deploy-and-lock.js.
 *
 * Usage:
 *   npx hardhat run scripts/timeout-part2-trigger.js --network sepolia
 */

const hre = require('hardhat');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const SAVE_FILE = path.join(__dirname, '../deployments/pending-timeout.json');

async function main() {
  if (!fs.existsSync(SAVE_FILE)) {
    throw new Error(`Không tìm thấy ${SAVE_FILE}. Hãy chạy timeout-part1-deploy-and-lock.js trước.`);
  }

  const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  const network = await hre.ethers.provider.getNetwork();

  console.log(`\nNetwork: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Vault: ${saved.vaultAddress}`);
  console.log(`Deadline: ${saved.timeoutDeadlineVN}\n`);

  // Kiểm tra deadline đã qua chưa
  const now = Math.floor(Date.now() / 1000);
  const remaining = saved.timeoutDeadlineTs - now;
  if (remaining > 0) {
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    console.error(`❌ Chưa đến hạn! Còn ${h}h ${m}m ${s}s.`);
    console.error(`   Thử lại sau: ${saved.timeoutDeadlineVN}`);
    process.exitCode = 1;
    return;
  }

  const [deployer] = await hre.ethers.getSigners();
  const vaultArtifact = await hre.artifacts.readArtifact('EscrowVault');
  const vault = new hre.ethers.Contract(saved.vaultAddress, vaultArtifact.abi, deployer);

  // Verify status trước khi gọi
  const statusBefore = await vault.status();
  if (Number(statusBefore) !== 1) {
    const names = ['CREATED', 'LOCKED', 'RELEASED', 'REFUNDED', 'DISPUTED'];
    throw new Error(`Vault status = ${names[Number(statusBefore)]}, expected LOCKED`);
  }

  console.log('[1] Status = LOCKED ✓');
  console.log('[2] Calling triggerTimeout()...');

  const tx = await vault.triggerTimeout();
  const receipt = await tx.wait();

  const statusAfter = await vault.status();
  const STATUS_NAMES = ['CREATED', 'LOCKED', 'RELEASED', 'REFUNDED', 'DISPUTED'];

  console.log(`\n✅ triggerTimeout SUCCESS`);
  console.log(`   Tx hash:  ${receipt.hash}`);
  console.log(`   Block:    ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed}`);
  console.log(`   Status:   ${STATUS_NAMES[Number(statusAfter)]} (expected: DISPUTED)`);

  if (Number(statusAfter) !== 4) {
    throw new Error(`Unexpected final status: ${STATUS_NAMES[Number(statusAfter)]}`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('Etherscan (Sepolia):');
  console.log(`  Contract:      https://sepolia.etherscan.io/address/${saved.vaultAddress}`);
  console.log(`  createEscrow:  https://sepolia.etherscan.io/tx/${saved.createTxHash}`);
  console.log(`  lockFunds:     https://sepolia.etherscan.io/tx/${saved.lockTxHash}`);
  console.log(`  triggerTimeout: https://sepolia.etherscan.io/tx/${receipt.hash}`);
  console.log('  → Mở triggerTimeout tx → tab "Logs" → thấy event DisputeOpened');
  console.log('─────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exitCode = 1;
});

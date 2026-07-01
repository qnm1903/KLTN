/**
 * smoke-real-timeout.js — Timeout E2E với EscrowVault thật (qua EscrowFactory)
 *
 * CÁCH DÙNG:
 *
 *   Step 1 — Chạy hôm nay: deploy + lockFunds (timeoutDays = 1 → deadline = ngày mai)
 *     STEP=deploy npx hardhat run scripts/smoke-real-timeout.js --network sepolia
 *
 *   Step 2 — Chạy ngày mai (sau 24h): gọi triggerTimeout
 *     STEP=trigger npx hardhat run scripts/smoke-real-timeout.js --network sepolia
 *
 * triggerTimeout() là permissionless — không cần TSS, không cần backend.
 * State được lưu vào deployments/sepolia-timeout-state.json sau Step 1.
 */

const hre = require('hardhat');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Secp256k1 generator point G — valid on-curve, dùng làm pkAgg placeholder
// triggerTimeout không verify signature nên giá trị pkAgg không ảnh hưởng kết quả
const G_X = '0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798';
const G_Y = '0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8';

const FACTORY_ADDRESS = '0x9FA0E4f0B20BeF312d3311c44B5960048F752576';
const AMOUNT          = ethers.parseEther('0.001');
const STATE_FILE      = path.join(__dirname, '../deployments/sepolia-timeout-state.json');

// ─── ABI tối thiểu cần dùng ─────────────────────────────────────────────────
const FACTORY_ABI = [
  'function createEscrow(address seller, address[] calldata mediators, uint256[2] calldata pkAggCoords, uint256 amount, uint256 confirmDays, uint256 timeoutDays, uint256 threshold) external returns (address)',
  'event EscrowCreatedEvent(address escrowAddress, bytes32 escrowId, address buyer, address seller, address[] mediators, uint256 threshold, uint256 numParties)'
];

const VAULT_ABI = [
  'function lockFunds() external payable',
  'function triggerTimeout() external',
  'function status() external view returns (uint8)',
  'function timeoutDeadline() external view returns (uint256)',
  'function escrowId() external view returns (bytes32)'
];

const STATUS_NAMES = ['CREATED', 'LOCKED', 'RELEASED', 'REFUNDED', 'DISPUTED'];

// ─── Step 1: deploy qua factory + lockFunds ──────────────────────────────────
async function stepDeploy() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeployer (buyer): ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  // Seller là địa chỉ ngẫu nhiên — chỉ cần nhận ETH, không gửi tx
  const seller = ethers.Wallet.createRandom().address;
  console.log(`Seller (random): ${seller}`);

  const factory = new hre.ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, deployer);

  // createEscrow qua factory — tạo EscrowVault thật
  console.log('\n[1] Gọi factory.createEscrow() với timeoutDays = 1...');
  const createTx = await factory.createEscrow(
    seller,
    [],        // không mediator
    [G_X, G_Y],
    AMOUNT,
    1,         // confirmDays = 1
    1,         // timeoutDays = 1 → deadline = lockFunds timestamp + 86400s
    1          // threshold = 1
  );
  const createReceipt = await createTx.wait();

  // Lấy địa chỉ vault từ event EscrowCreatedEvent
  const iface = new hre.ethers.Interface(FACTORY_ABI);
  let vaultAddress;
  for (const log of createReceipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'EscrowCreatedEvent') {
        vaultAddress = parsed.args.escrowAddress;
        break;
      }
    } catch { /* skip unrelated logs */ }
  }

  if (!vaultAddress) throw new Error('Không tìm thấy EscrowCreatedEvent trong receipt');
  console.log(`✓ EscrowVault deployed: ${vaultAddress}`);
  console.log(`  createEscrow tx: ${createReceipt.hash}`);

  // lockFunds — buyer = deployer
  console.log('\n[2] Gọi lockFunds()...');
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_ABI, deployer);
  const lockTx = await vault.lockFunds({ value: AMOUNT });
  const lockReceipt = await lockTx.wait();
  console.log(`✓ lockFunds tx: ${lockReceipt.hash}`);
  console.log(`  Gas used: ${lockReceipt.gasUsed}`);

  const timeoutDeadline = await vault.timeoutDeadline();
  const deadlineDate = new Date(Number(timeoutDeadline) * 1000);
  console.log(`\n⏰ Timeout deadline: ${deadlineDate.toISOString()} (${deadlineDate.toLocaleString('vi-VN')})`);
  console.log(`   Gọi step trigger SAU thời điểm trên.`);

  // Lưu state để dùng ở Step 2
  const state = {
    vaultAddress,
    seller,
    createTxHash: createReceipt.hash,
    lockTxHash: lockReceipt.hash,
    timeoutDeadline: timeoutDeadline.toString(),
    timeoutDeadlineISO: deadlineDate.toISOString(),
    amount: AMOUNT.toString(),
    network: 'sepolia'
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\n✓ State saved → ${STATE_FILE}`);

  console.log('\n─────────────────────────────────────────────');
  console.log('Etherscan:');
  console.log(`  Contract:  https://sepolia.etherscan.io/address/${vaultAddress}`);
  console.log(`  lockFunds: https://sepolia.etherscan.io/tx/${lockReceipt.hash}`);
  console.log('─────────────────────────────────────────────');
  console.log('\nChạy step trigger vào ngày mai:');
  console.log('  STEP=trigger npx hardhat run scripts/smoke-real-timeout.js --network sepolia\n');
}

// ─── Step 2: gọi triggerTimeout sau khi deadline qua ─────────────────────────
async function stepTrigger() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`Chưa có state file. Chạy --step deploy trước.\nExpected: ${STATE_FILE}`);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  console.log(`\nVault:    ${state.vaultAddress}`);
  console.log(`Deadline: ${state.timeoutDeadlineISO}`);

  const [deployer] = await hre.ethers.getSigners();
  const vault = new hre.ethers.Contract(state.vaultAddress, VAULT_ABI, deployer);

  // Kiểm tra trạng thái hiện tại
  const currentStatus = await vault.status();
  console.log(`Status hiện tại: ${STATUS_NAMES[Number(currentStatus)]}`);

  if (Number(currentStatus) !== 1 /* LOCKED */) {
    console.log('⚠ Vault không ở trạng thái LOCKED. Bỏ qua.');
    return;
  }

  // Kiểm tra deadline
  const now = BigInt((await hre.ethers.provider.getBlock('latest')).timestamp);
  const deadline = BigInt(state.timeoutDeadline);

  if (now <= deadline) {
    const remaining = Number(deadline - now);
    const hours   = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    console.log(`\n⏳ Chưa đến hạn. Còn ${hours}h ${minutes}m.`);
    console.log(`   Deadline: ${state.timeoutDeadlineISO}`);
    console.log('   Chạy lại script này sau khi qua deadline.');
    return;
  }

  // Gọi triggerTimeout
  console.log('\n[1] Gọi triggerTimeout()...');
  const tx = await vault.triggerTimeout();
  const receipt = await tx.wait();

  const finalStatus = await vault.status();
  console.log(`\n✅ triggerTimeout SUCCESS`);
  console.log(`   Tx hash:  ${receipt.hash}`);
  console.log(`   Block:    ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed}`);
  console.log(`   Status:   ${STATUS_NAMES[Number(finalStatus)]} (expected: DISPUTED)`);

  if (Number(finalStatus) !== 4) throw new Error('Status không phải DISPUTED!');

  // Cập nhật state file
  state.triggerTxHash = receipt.hash;
  state.triggerBlock  = receipt.blockNumber;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log('\n─────────────────────────────────────────────');
  console.log('Etherscan — tab Logs → DisputeOpened event:');
  console.log(`  https://sepolia.etherscan.io/tx/${receipt.hash}`);
  console.log('─────────────────────────────────────────────\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  const step = process.env.STEP;

  if (!step) {
    console.log('Usage:');
    console.log('  --step deploy   → deploy + lockFunds (chạy hôm nay)');
    console.log('  --step trigger  → triggerTimeout (chạy ngày mai)');
    process.exit(1);
  }

  if (step === 'deploy')        await stepDeploy();
  else if (step === 'trigger')  await stepTrigger();
  else throw new Error(`Unknown step: ${step}. Dùng deploy hoặc trigger.`);
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exitCode = 1;
});

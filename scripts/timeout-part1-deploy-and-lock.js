/**
 * timeout-part1-deploy-and-lock.js
 *
 * Bước 1/2 cho kịch bản Quá hạn trên Sepolia.
 * Tạo EscrowVault thật qua Factory, lock funds, lưu thông tin vào file JSON.
 * Chạy timeout-part2-trigger.js sau >= 24 giờ để hoàn tất.
 *
 * Usage:
 *   npx hardhat run scripts/timeout-part1-deploy-and-lock.js --network sepolia
 */

const hre = require('hardhat');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// EscrowFactory đã deploy trên Sepolia
const FACTORY_ADDRESS = '0x9FA0E4f0B20BeF312d3311c44B5960048F752576';

// secp256k1 generator point G — valid on-curve
// triggerTimeout() không verify chữ ký nên pkAgg = G là hợp lệ
const G_X = '0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798';
const G_Y = '0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8';

const AMOUNT = ethers.parseEther('0.001');
const TIMEOUT_DAYS = 1; // 1 ngày = 86400 giây trên chain
const SAVE_FILE = path.join(__dirname, '../deployments/pending-timeout.json');

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  console.log(`\nNetwork: ${network.name} (chainId: ${network.chainId})`);

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Buyer (deployer): ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  // Seller là ví random — chỉ nhận ETH, không gửi tx
  const seller = ethers.Wallet.createRandom();
  console.log(`Seller (random): ${seller.address}`);

  // Load factory ABI
  const factoryArtifact = await hre.artifacts.readArtifact('EscrowFactory');
  const factory = new hre.ethers.Contract(FACTORY_ADDRESS, factoryArtifact.abi, deployer);

  // 1. Tạo EscrowVault qua Factory
  console.log('\n[1] Creating EscrowVault via Factory...');
  const createTx = await factory.createEscrow(
    seller.address,
    [],            // không có mediator — simplest config cho test
    [G_X, G_Y],   // pkAgg = G (valid point)
    AMOUNT,
    TIMEOUT_DAYS,  // confirmDays = 1
    TIMEOUT_DAYS,  // timeoutDays = 1
    1              // threshold = 1 (buyer đủ để count)
  );
  const createReceipt = await createTx.wait();

  // Parse địa chỉ vault từ event EscrowCreatedEvent
  const factoryInterface = new hre.ethers.Interface(factoryArtifact.abi);
  let vaultAddress, escrowId;
  for (const log of createReceipt.logs) {
    try {
      const parsed = factoryInterface.parseLog(log);
      if (parsed && parsed.name === 'EscrowCreatedEvent') {
        vaultAddress = parsed.args.escrowAddress;
        escrowId = parsed.args.escrowId;
        break;
      }
    } catch (_) {}
  }

  if (!vaultAddress) throw new Error('EscrowCreatedEvent not found in logs');

  console.log(`✓ EscrowVault deployed: ${vaultAddress}`);
  console.log(`  createEscrow tx: ${createReceipt.hash}`);
  console.log(`  Gas used: ${createReceipt.gasUsed}`);

  // 2. Lock funds (deployer = buyer)
  console.log('\n[2] Calling lockFunds()...');
  const vaultArtifact = await hre.artifacts.readArtifact('EscrowVault');
  const vault = new hre.ethers.Contract(vaultAddress, vaultArtifact.abi, deployer);

  const lockTx = await vault.lockFunds({ value: AMOUNT });
  const lockReceipt = await lockTx.wait();

  // Lấy timeoutDeadline từ contract (được set tại lockFunds)
  const timeoutDeadline = await vault.timeoutDeadline();
  const deadlineDate = new Date(Number(timeoutDeadline) * 1000);

  console.log(`✓ lockFunds tx: ${lockReceipt.hash}`);
  console.log(`  Gas used: ${lockReceipt.gasUsed}`);
  console.log(`  timeoutDeadline (UTC): ${deadlineDate.toISOString()}`);
  console.log(`  timeoutDeadline (+7):  ${deadlineDate.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);

  // 3. Lưu thông tin để Part 2 đọc
  const savedData = {
    network: network.name,
    chainId: Number(network.chainId),
    vaultAddress,
    escrowId,
    buyer: deployer.address,
    seller: seller.address,
    amount: AMOUNT.toString(),
    createTxHash: createReceipt.hash,
    lockTxHash: lockReceipt.hash,
    timeoutDeadlineTs: Number(timeoutDeadline),
    timeoutDeadlineISO: deadlineDate.toISOString(),
    timeoutDeadlineVN: deadlineDate.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    savedAt: new Date().toISOString()
  };

  fs.writeFileSync(SAVE_FILE, JSON.stringify(savedData, null, 2));

  console.log(`\n✅ Thông tin đã lưu: ${SAVE_FILE}`);
  console.log('\n─────────────────────────────────────────────');
  console.log('Etherscan (Sepolia):');
  console.log(`  Contract: https://sepolia.etherscan.io/address/${vaultAddress}`);
  console.log(`  createEscrow: https://sepolia.etherscan.io/tx/${createReceipt.hash}`);
  console.log(`  lockFunds:    https://sepolia.etherscan.io/tx/${lockReceipt.hash}`);
  console.log('─────────────────────────────────────────────');
  console.log(`\n⏳ Chờ đến: ${deadlineDate.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
  console.log('   Sau đó chạy:');
  console.log('   npx hardhat run scripts/timeout-part2-trigger.js --network sepolia\n');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exitCode = 1;
});

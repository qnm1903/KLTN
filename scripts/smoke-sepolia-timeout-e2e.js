/**
 * smoke-sepolia-timeout-e2e.js
 *
 * E2E smoke test for triggerTimeout() on Sepolia testnet.
 * Uses EscrowVaultTest.sol (seconds-based deadline, not days) so we don't wait 24h.
 *
 * Flow:
 *   1. Deploy EscrowVaultTest with timeoutSeconds = 10
 *   2. deployer acts as buyer and calls lockFunds()
 *   3. Wait 15 seconds for deadline to pass
 *   4. Call triggerTimeout() — transitions LOCKED → DISPUTED
 *   5. Print tx hash → check on Sepolia Etherscan → Logs tab shows DisputeOpened event
 *
 * triggerTimeout() is permissionless (no TSS signature needed) so this script
 * is self-contained and does not require the backend server.
 *
 * Usage:
 *   npx hardhat run scripts/smoke-sepolia-timeout-e2e.js --network sepolia
 *
 * Env (from .env):
 *   SEPOLIA_RPC_URL  - Alchemy/Infura RPC
 *   PRIVATE_KEY      - deployer/buyer wallet key
 */

const hre = require('hardhat');
const { ethers } = require('ethers');

// secp256k1 generator point G — valid on-curve, used as placeholder pkAgg
// triggerTimeout does not verify any signature so pkAgg value doesn't matter
const G_X = '0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798';
const G_Y = '0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8';

const TIMEOUT_SECONDS = 10;   // 10s until timeout deadline
const AMOUNT = ethers.parseEther('0.001');  // minimal escrow amount

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  console.log(`\nNetwork: ${network.name} (chainId: ${network.chainId})`);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer/buyer: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  // Use a fresh seller address — only receives ETH, does not send txs
  const seller = ethers.Wallet.createRandom();
  console.log(`Seller (random): ${seller.address}`);

  // 1. Deploy EscrowVaultTest
  console.log('\n[1] Deploying EscrowVaultTest...');
  const EscrowVaultTest = await hre.ethers.getContractFactory('EscrowVaultTest');

  const escrowId = hre.ethers.id(`timeout-test-${Date.now()}`);

  const vault = await EscrowVaultTest.deploy(
    escrowId,
    deployer.address,    // buyer = deployer
    seller.address,
    [],                  // no mediators
    [G_X, G_Y],         // pkAgg = G (valid point, not used for triggerTimeout)
    AMOUNT,
    TIMEOUT_SECONDS,     // confirmSeconds
    TIMEOUT_SECONDS,     // timeoutSeconds
    1                    // threshold = 1 (buyer alone counts as core)
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`✓ EscrowVaultTest deployed: ${vaultAddr}`);

  // 2. Lock funds (deployer = buyer)
  console.log('\n[2] Calling lockFunds()...');
  const lockTx = await vault.lockFunds({ value: AMOUNT });
  const lockReceipt = await lockTx.wait();
  console.log(`✓ lockFunds tx: ${lockReceipt.hash}`);
  console.log(`  Gas used: ${lockReceipt.gasUsed}`);
  console.log(`  timeoutDeadline = block.timestamp + ${TIMEOUT_SECONDS}s`);

  // 3. Wait for timeout deadline to pass
  const waitMs = (TIMEOUT_SECONDS + 5) * 1000;
  console.log(`\n[3] Waiting ${TIMEOUT_SECONDS + 5}s for deadline to pass...`);
  await new Promise(r => setTimeout(r, waitMs));

  // 4. Call triggerTimeout — permissionless, anyone can call after deadline
  console.log('\n[4] Calling triggerTimeout()...');
  const timeoutTx = await vault.triggerTimeout();
  const timeoutReceipt = await timeoutTx.wait();

  console.log(`\n✅ triggerTimeout SUCCESS`);
  console.log(`   Tx hash:   ${timeoutReceipt.hash}`);
  console.log(`   Block:     ${timeoutReceipt.blockNumber}`);
  console.log(`   Gas used:  ${timeoutReceipt.gasUsed}`);

  // 5. Verify final state
  const finalStatus = await vault.status();
  const STATUS_NAMES = ['CREATED', 'LOCKED', 'RELEASED', 'REFUNDED', 'DISPUTED'];
  console.log(`   Status:    ${STATUS_NAMES[Number(finalStatus)]} (expected: DISPUTED)`);

  if (Number(finalStatus) !== 4) {
    throw new Error(`Unexpected status: ${STATUS_NAMES[Number(finalStatus)]}`);
  }

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`Etherscan (Sepolia):`);
  console.log(`  Contract: https://sepolia.etherscan.io/address/${vaultAddr}`);
  console.log(`  Tx:       https://sepolia.etherscan.io/tx/${timeoutReceipt.hash}`);
  console.log(`  → Click "Logs" tab to see DisputeOpened event`);
  console.log(`─────────────────────────────────────────────\n`);
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exitCode = 1;
});

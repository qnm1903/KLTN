/**
 * smoke-sepolia.js
 *
 * End-to-end smoke test for Schnorr threshold escrow on Sepolia testnet.
 *
 * Executes complete flow:
 * 1. Deploy EscrowFactory (or read from deployments/sepolia.json)
 * 2. Create 7 test wallets (buyer, seller, mediator1..mediator5)
 * 3. Initialize backend session via /api/escrow/init
 * 4. Lock funds in EscrowVault
 * 5. Round 1: Collect nonces via /api/escrow/nonce
 * 6. Round 2: Collect z-shares via /api/escrow/sign
 * 7. Call release/refund/timeout on-chain
 * 8. Collect gas metrics for each action
 *
 * Usage:
 *   node scripts/smoke-sepolia.js [--deploy] [--action release|refund|timeout] [--lane-only]
 *
 * Env:
 *   SEPOLIA_RPC_URL    - RPC endpoint
 *   PRIVATE_KEY        - Deployer private key
 *   BACKEND_URL        - Backend API base URL (default: http://localhost:3001)
 *   ETHERSCAN_API_KEY  - For verification (optional)
 */

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const axios = require('axios');
const EC = require('elliptic').ec;
const { ethers } = require('ethers');

const ec = new EC('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─── Configuration ──────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const DEPLOYMENT_FILE = path.join(__dirname, '..', 'deployments', 'sepolia.json');
const GAS_RESULTS_FILE = path.join(__dirname, '..', 'gas_results.json');

// Parse command-line args
const args = process.argv.slice(2);
let shouldDeploy = args.includes('--deploy');
let selectedAction = 'release';
let laneOnly = false;

// Extract action name (first positional arg that's an action)
for (let i = 0; i < args.length; i++) {
  if (['release', 'refund', 'timeout'].includes(args[i])) {
    selectedAction = args[i];
    laneOnly = true; // If specific action provided, assume lane-only mode
    break;
  }
}

const ACTIONS = laneOnly ? [selectedAction] : ['release', 'refund', 'timeout'];



// ─── Helper types ──────────────────────────────────────────────────────────────

class TestWallet {
  constructor(address, pubKey, privKey, signer) {
    this.address = address;
    this.pubKey = pubKey; // 65 chars uncompressed hex (no 04 prefix)
    this.privKey = privKey;
    this.signer = signer;
  }
}

const PARTICIPANT_ROLES = ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5'];
const ACTION_SIGNER_SETS = {
  release: ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3'],
  refund: ['buyer', 'mediator1', 'mediator2', 'mediator3', 'mediator4'],
  timeout: ['seller', 'mediator2', 'mediator3', 'mediator4', 'mediator5']
};

function signerBitmapForRoles(roles) {
  const roleBits = {
    buyer: 0,
    seller: 1,
    mediator1: 2,
    mediator2: 3,
    mediator3: 4,
    mediator4: 5,
    mediator5: 6
  };

  return roles.reduce((bitmap, role) => bitmap | (1 << roleBits[role]), 0);
}

class SigningContext {
  constructor(escrowId, action, parties, pubKeys) {
    this.escrowId = escrowId;
    this.action = action;
    this.parties = parties; // { buyer, seller, mediators: [] }
    this.pubKeys = pubKeys; // { buyer, seller, mediator1..mediator5 }
    this.msgHash = null;
    this.R = null; // Aggregated nonce point
    this.signers = []; // Roles that will sign (5 of 7)
    this.signerBitmap = 0;
    this.nonces = {}; // { role => R_i }
    this.zShares = {}; // { role => z_i }
    this.finalSig = null; // { rAddr, z, e }
    this.gasUsed = 0;
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────────

async function loadOrDeployFactory() {
  console.log('Loading/Deploying EscrowFactory...\n');

  let factoryAddress = null;

  // Try to load from deployments
  if (fs.existsSync(DEPLOYMENT_FILE)) {
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    if (deployment.contracts?.EscrowFactory?.address) {
      factoryAddress = deployment.contracts.EscrowFactory.address;
      console.log(`✓ Loaded factory from deployment: ${factoryAddress}\n`);
    }
  }

  // Deploy if needed
  if (!factoryAddress) {
    // Auto-deploy on local hardhat network
    const network = await hre.ethers.provider.getNetwork();
    const isLocalNetwork = network.name === 'hardhat' || !SEPOLIA_RPC;
    
    if (!shouldDeploy && !isLocalNetwork) {
      throw new Error(
        `Factory not found at ${DEPLOYMENT_FILE}. ` +
        'Run with --deploy flag or execute: npm run deploy:sepolia'
      );
    }

    console.log('🔨 Deploying EscrowFactory...');
    const [signer] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory('EscrowFactory');
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    factoryAddress = await factory.getAddress();
    console.log(`✓ Deployed factory at: ${factoryAddress}\n`);
  }

  // Verify network
  const network = await hre.ethers.provider.getNetwork();
  const networkName = network.name;
  console.log(`ℹ️  Network: ${networkName} (ChainId: ${network.chainId})\n`);

  return factoryAddress;
}

function aggregatePubKeys(pubKeys) {
  const keys = Array.isArray(pubKeys) ? pubKeys : Array.from(arguments);
  if (!keys.length) {
    throw new Error('At least one public key is required');
  }

  const [first, ...rest] = keys;
  let sum = ec.keyFromPublic('04' + first, 'hex').getPublic();

  for (const pubKey of rest) {
    const point = ec.keyFromPublic('04' + pubKey, 'hex').getPublic();
    sum = sum.add(point);
  }

  return {
    x: '0x' + sum.getX().toString(16).padStart(64, '0'),
    y: '0x' + sum.getY().toString(16).padStart(64, '0')
  };
}

// Generate and fund 7 wallets with secp256k1 keys
async function createTestWallets(provider, funder) {
  console.log('🔑 Creating test wallets...\n');

  const wallets = {};
  for (const role of PARTICIPANT_ROLES) {
    const signer = ethers.Wallet.createRandom().connect(provider);
    const privKey = signer.privateKey.replace('0x', '');
    const pubKeyWithPrefix = ethers.SigningKey.computePublicKey(signer.privateKey, false);
    const pubKey = pubKeyWithPrefix.replace('0x04', '');

    wallets[role] = new TestWallet(signer.address, pubKey, privKey, signer);

    const fundTx = await funder.sendTransaction({
      to: signer.address,
      value: ethers.parseEther('1')
    });
    await fundTx.wait();

    console.log(`  ${role}: ${signer.address} (pubKey: 04${pubKey.slice(0, 16)}...)`);
  }

  console.log();
  return wallets;
}

// ─── Backend Communication ──────────────────────────────────────────────────────

async function backendInit(ctx, wallets) {
  console.log(`Backend /init for action=${ctx.action}...\n`);

  const payload = {
    escrowId: ctx.escrowId,
    chainId: String(await hre.ethers.provider.getNetwork().then((network) => network.chainId)),
    contractAddress: ctx.contractAddress,
    buyerAddr: wallets.buyer.address,
    sellerAddr: wallets.seller.address,
    mediatorAddrs: [
      wallets.mediator1.address,
      wallets.mediator2.address,
      wallets.mediator3.address,
      wallets.mediator4.address,
      wallets.mediator5.address
    ],
    buyerPubKey: wallets.buyer.pubKey,
    sellerPubKey: wallets.seller.pubKey,
    mediatorPubKeys: [
      wallets.mediator1.pubKey,
      wallets.mediator2.pubKey,
      wallets.mediator3.pubKey,
      wallets.mediator4.pubKey,
      wallets.mediator5.pubKey
    ]
  };

  try {
    const response = await axios.post(`${BACKEND_URL}/api/escrow/init`, payload, {
      timeout: 10000
    });
    
    console.log(`✓ Session initialized`);
    console.log(`  contract: ${ctx.contractAddress}`);
    console.log(`  signerBitmap: 0x${ctx.signerBitmap.toString(16)}\n`);
  } catch (err) {
    throw new Error(`Backend /init failed: ${err.message}`);
  }
}

async function backendNonce(ctx, wallets, role) {
  console.log(`  📤 /nonce from ${role}...`);

  // Generate random nonce k_i
  const privKey = wallets[role].privKey;
  const kBigInt = BigInt('0x' + ec.genKeyPair().getPrivate('hex'));
  const kModN = kBigInt % ORDER;

  // R_i = k_i * G
  const kKey = ec.keyFromPrivate(kModN.toString(16).padStart(64, '0'));
  const R = kKey.getPublic();

  // Store for later aggregation
  ctx.nonces[role] = {
    R_x: '0x' + R.getX().toString(16).padStart(64, '0'),
    R_y: '0x' + R.getY().toString(16).padStart(64, '0'),
    k: kModN // Store for round 2
  };

  const payload = {
    escrowId: ctx.escrowId,
    role,
    action: ctx.action,
    signerBitmap: ctx.signerBitmap,
    R_x: ctx.nonces[role].R_x,
    R_y: ctx.nonces[role].R_y
  };

  try {
    const response = await axios.post(`${BACKEND_URL}/api/escrow/nonce`, payload, {
      timeout: 10000
    });
    console.log(`    ✓ Nonce accepted`);
    
    // Backend returns { ok: true, R_addr, challenge, msgHash, pkAgg } when both nonces received
    if (response.data.R_addr) {
      ctx.R_addr = response.data.R_addr;
      ctx.e = BigInt(response.data.challenge);
      ctx.msgHash = response.data.msgHash;
      ctx.pkAggFinal = response.data.pkAgg;
      console.log(`    ✓ Round 1 complete, challenge e computed`);
    } else {
      console.log(`    ✓ Waiting for second nonce...`);
    }
    
    return response.data;
  } catch (err) {
    throw new Error(`Backend /nonce failed for ${role}: ${err.message}`);
  }
}

async function backendSign(ctx, wallets, role) {
  console.log(`  /sign from ${role}...`);

  // Get aggregated challenge e from context
  if (!ctx.e) {
    throw new Error('Challenge e not available. Did round 1 complete?');
  }

  // Compute z_i = k_i + e * s_i (mod ORDER)
  const k_i = ctx.nonces[role].k;
  const e = ctx.e % ORDER;
  const s_i = BigInt('0x' + wallets[role].privKey) % ORDER;
  const z_i = (k_i + (e * s_i) % ORDER) % ORDER;

  ctx.zShares[role] = z_i;

  const payload = {
    escrowId: ctx.escrowId,
    role,
    signerBitmap: ctx.signerBitmap,
    z: '0x' + z_i.toString(16).padStart(64, '0')
  };

  try {
    const response = await axios.post(`${BACKEND_URL}/api/escrow/sign`, payload, {
      timeout: 10000
    });
    console.log(`    ✓ z-share submitted`);

    // Backend returns full signature when both z-shares received
    if (response.data.R_addr) {
      ctx.finalSig = response.data;
      console.log(`    ✓ Signature aggregated by backend\n`);
      console.log(`      Signature: {`);
      console.log(`        rAddr: ${ctx.finalSig.R_addr}`);
      console.log(`        z: ${ctx.finalSig.z}`);
      console.log(`        e: ${ctx.finalSig.e}`);
      console.log(`      }\n`);
    } else {
      console.log(`    ✓ Waiting for second z-share...`);
    }

    return response.data;
  } catch (err) {
    throw new Error(`Backend /sign failed for ${role}: ${err.message}`);
  }
}

// ─── On-Chain Actions ───────────────────────────────────────────────────────────

async function lockFunds(vault, buyer, amount) {
  console.log(` Locking funds (${ethers.formatEther(amount)} ETH)...\n`);

  const tx = await vault.lockFunds({ value: amount });
  const receipt = await tx.wait();

  console.log(`✓ Funds locked`);
  console.log(`  Tx: ${receipt.hash}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}\n`);

  return receipt;
}

async function callRelease(vault, sig) {
  console.log(`✓ Calling release()...\n`);

  const rAddr = sig.R_addr || sig.rAddr;
  const tx = await vault.release(rAddr, sig.z, sig.e, sig.msgHash, sig.signerBitmap);
  const receipt = await tx.wait();

  console.log(`✓ Release executed`);
  console.log(`  Tx: ${receipt.hash}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}\n`);

  return receipt;
}

async function callRefund(vault, sig) {
  console.log(`✓ Calling refund()...\n`);

  const rAddr = sig.R_addr || sig.rAddr;
  const tx = await vault.refund(rAddr, sig.z, sig.e, sig.msgHash, sig.signerBitmap);
  const receipt = await tx.wait();

  console.log(`✓ Refund executed`);
  console.log(`  Tx: ${receipt.hash}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}\n`);

  return receipt;
}

async function callTriggerTimeout(vault) {
  console.log(`⏰ Advancing time for timeout...\n`);

  // Advance time on hardhat/local testnet
  const timeoutDeadline = await vault.timeoutDeadline();
  const now = BigInt((await hre.ethers.provider.getBlock('latest')).timestamp);

  if (now <= timeoutDeadline) {
    const advanceBy = timeoutDeadline - now + 1n;
    await hre.network.provider.send('hardhat_mine', [
      '0x' + (advanceBy).toString(16),
      '0x1' // interval
    ]);
    console.log(`✓ Advanced time by ${advanceBy} seconds\n`);
  }

  console.log(`✓ Calling triggerTimeout()...\n`);

  // Quá hạn → chuyển LOCKED sang DISPUTED (không cần chữ ký TSS).
  const tx = await vault.triggerTimeout();
  const receipt = await tx.wait();

  console.log(`✓ Timeout triggered → DISPUTED`);
  console.log(`  Tx: ${receipt.hash}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}\n`);

  return receipt;
}

// ─── Metrics Collection ──────────────────────────────────────────────────────────

async function updateGasMetrics(action, gasUsed) {
  let metrics = { tss: {}, multisig: {} };

  if (fs.existsSync(GAS_RESULTS_FILE)) {
    metrics = JSON.parse(fs.readFileSync(GAS_RESULTS_FILE, 'utf8'));
  }

  if (!metrics.tss) metrics.tss = {};
  if (!metrics.tss[action]) metrics.tss[action] = [];

  metrics.tss[action].push({
    gasUsed: gasUsed.toString(),
    timestamp: new Date().toISOString()
  });

  fs.writeFileSync(GAS_RESULTS_FILE, JSON.stringify(metrics, null, 2));
  console.log(`📊 Gas metrics saved to ${GAS_RESULTS_FILE}\n`);
}

// ─── Main Smoke Test Flow ───────────────────────────────────────────────────────

async function runSmokeTest(action) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔥 SMOKE TEST: ${action.toUpperCase()}`);
  console.log(`${'='.repeat(70)}\n`);

  const [funder] = await hre.ethers.getSigners();
  const wallets = await createTestWallets(hre.ethers.provider, funder);

  // Determine signers for this action
  const signers = ACTION_SIGNER_SETS[action];
  if (!signers) {
    throw new Error(`Unsupported action: ${action}`);
  }
  const mediatorRoles = ['mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5'];
  const signerBitmap = signerBitmapForRoles(signers);

  // Create context (escrowId will be set after EscrowCreatedEvent)
  const ctx = new SigningContext('', action, {
    buyer: wallets.buyer.address,
    seller: wallets.seller.address,
    mediators: mediatorRoles.map((role) => wallets[role].address)
  }, {
    buyer: wallets.buyer.pubKey,
    seller: wallets.seller.pubKey,
    mediator1: wallets.mediator1.pubKey,
    mediator2: wallets.mediator2.pubKey,
    mediator3: wallets.mediator3.pubKey,
    mediator4: wallets.mediator4.pubKey,
    mediator5: wallets.mediator5.pubKey
  });

  ctx.signers = signers;
  ctx.signerBitmap = signerBitmap;

  try {
    // 1. Load factory
    const factoryAddress = await loadOrDeployFactory();
    const Factory = await hre.ethers.getContractFactory('EscrowFactory');
    const factory = Factory.attach(factoryAddress);

    // 2. Build local PKagg coordinates for vault creation from the active signer set
    const pkAgg = aggregatePubKeys(signers.map((role) => wallets[role].pubKey));

    // 3. Create escrow vault from buyer wallet
    console.log(`🏗️  Creating EscrowVault...\n`);

    const fullPkCoords = [pkAgg.x, pkAgg.y];
    const mediatorAddresses = mediatorRoles.map((role) => wallets[role].address);

    const createTx = await factory.connect(wallets.buyer.signer).createEscrow(
      wallets.seller.address,
      mediatorAddresses,
      fullPkCoords,
      ethers.parseEther('0.1'),
      1, // confirmDays
      1  // timeoutDays
    );

    const createReceipt = await createTx.wait();
    
    // Check if transaction succeeded
    if (!createReceipt || createReceipt.status === 0) {
      console.error('Transaction failed or reverted');
      console.error('Receipt:', createReceipt);
      throw new Error('createEscrow transaction failed');
    }
    
    console.log(`✓ Transaction succeeded at block ${createReceipt.blockNumber}`);
    console.log(`  Tx hash: ${createReceipt.hash}`);
    console.log(`  Gas used: ${createReceipt.gasUsed}`);
    console.log(`  Total logs: ${createReceipt.logs.length}\n`);
    
    // Parse EscrowCreatedEvent from receipt logs using queryFilter
    const events = await factory.queryFilter(
      factory.filters.EscrowCreatedEvent(),
      createReceipt.blockNumber,
      createReceipt.blockNumber
    );
    
    if (events.length === 0) {
      console.error(`No EscrowCreatedEvent found in block ${createReceipt.blockNumber}`);
      console.error(`Total logs in receipt: ${createReceipt.logs.length}`);
      throw new Error('EscrowCreatedEvent not found in tx receipt');
    }
    
    const parsedEvent = events[0]; // Get first event (should be ours)
    const vaultAddr = parsedEvent.args.escrowAddress || parsedEvent.args[0];
    const emittedEscrowId = parsedEvent.args.escrowId || parsedEvent.args[1];
    ctx.escrowId = emittedEscrowId;
    ctx.contractAddress = vaultAddr;

    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const id = ctx.escrowId.startsWith('0x') ? ctx.escrowId : ethers.id(ctx.escrowId);
    ctx.msgHash = ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'bytes32', 'string', 'uint8'],
      [chainId, ctx.contractAddress, id, ctx.action, ctx.signerBitmap]
    );

    // 4. Initialize backend with the actual on-chain escrowId
    await backendInit(ctx, wallets);

    console.log(`✓ Vault created at: ${vaultAddr}\n`);

    const vault = await hre.ethers.getContractAt('EscrowVault', vaultAddr);

    // 5. Lock funds (buyer deposits)
    const amount = ethers.parseEther('0.1');
    await lockFunds(vault.connect(wallets.buyer.signer), wallets.buyer.signer, amount);

    let receipt;

    // Luồng quá hạn nay không cần TSS: ai cũng gọi triggerTimeout() để chuyển sang DISPUTED.
    if (action === 'timeout') {
      console.log(`🚀 Executing on-chain ${action}...\n`);
      receipt = await callTriggerTimeout(vault);
    } else {
      // 6. Backend round 1: Collect nonces from the action committee
      console.log(`🔄 Round 1: Collecting nonces from ${signers.join(' + ')}...\n`);
      for (const role of signers) {
        await backendNonce(ctx, wallets, role);
      }

      // Verify challenge was set
      if (!ctx.e) {
        throw new Error('Challenge e not set after round 1. Check backend nonce responses.');
      }

      // 7. Backend round 2: Collect z-shares
      console.log(`🔄 Round 2: Collecting z-shares from ${signers.join(' + ')}...\n`);
      for (const role of signers) {
        await backendSign(ctx, wallets, role);
      }

      // Verify signature is available
      if (!ctx.finalSig || !ctx.finalSig.R_addr) {
        throw new Error('Final signature not available. Check backend sign responses.');
      }

      console.log(`✓ Signature ready for on-chain execution\n`);

      // 8. Call on-chain action
      console.log(`🚀 Executing on-chain ${action}...\n`);
      switch (action) {
        case 'release':
          receipt = await callRelease(vault, ctx.finalSig);
          break;
        case 'refund':
          receipt = await callRefund(vault, ctx.finalSig);
          break;
      }
    }

    // 9. Update metrics
    await updateGasMetrics(action, receipt.gasUsed);

    // 10. Verify final state
    const finalStatus = await vault.status();
    const statusNames = ['CREATED', 'LOCKED', 'RELEASED', 'REFUNDED', 'DISPUTED'];
    console.log(`✅ Final escrow status: ${statusNames[finalStatus]}\n`);

  } catch (error) {
    console.error(`❌ Smoke test failed: ${error.message}`);
    if (error.response?.data) {
      console.error('Backend response:', error.response.data);
    }
    throw error;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '▌'.repeat(35));
  console.log('  Schnorr Escrow - Sepolia Smoke Test');

  console.log(`\nNetwork: Sepolia`);
  console.log(`Backend: ${BACKEND_URL}`);
  console.log(`Deployment: ${DEPLOYMENT_FILE}`);
  console.log();

  for (const action of ACTIONS) {
    try {
      await runSmokeTest(action);
    } catch (err) {
      console.error(`\nAction ${action} failed:`, err.message);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`All smoke tests passed!`);
  console.log(`${'='.repeat(70)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});

// escrow-tss/scripts/seed-mediators.js

import { ethers } from 'ethers';
// Persist on-chain registrations into backend DB
import prisma from '../src/lib/prisma.js';

const MEDIATOR_POOL_ABI = [
  'function registerAsMediator() external payable',
  'function getRequiredStake() external view returns (uint256)',
  'function getAllMediators() external view returns (tuple(address wallet, uint256 stakeAmount, bool isActive, uint256 timeoutCount, uint256 reputationScore, uint256 totalVotes, uint256 successfulVotes)[])'
];

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MEDIATOR_POOL = process.env.MEDIATOR_POOL_CONTRACT;

function envFlag(name, fallback = false) {
  const value = String(process.env[name] ?? fallback).toLowerCase().trim();
  return value === 'true' || value === '1' || value === 'yes';
}

function isInsufficientFundsError(error) {
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('insufficient funds') || msg.includes('gas * price + value');
}

if (!RPC_URL || !PRIVATE_KEY || !MEDIATOR_POOL) {
  console.error('Missing env vars: RPC_URL, PRIVATE_KEY, MEDIATOR_POOL_CONTRACT');
  process.exit(1);
}

(async () => {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signerWallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(MEDIATOR_POOL, MEDIATOR_POOL_ABI, signerWallet);
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const isLocalChain = chainId === 31337 || chainId === 1337;

    console.log('📡 Connected to:', RPC_URL);
    console.log('🌐 Chain ID:', chainId);
    console.log('💼 Signer wallet:', signerWallet.address);
    console.log('📋 MediatorPool contract:', MEDIATOR_POOL);

    // 1. Lấy required stake (khi đăng ký)
    console.log('\n🔍 Fetching required stake for registration...');
    const stakeWei = await contract.getRequiredStake();
    const stakeETH = ethers.formatEther(stakeWei);
    console.log('✅ Required stake per registration:', stakeETH, 'ETH');

    // 2. Check balance
    const balance = await provider.getBalance(signerWallet.address);
    console.log('💰 Signer balance:', ethers.formatEther(balance), 'ETH');

    const MEDIATOR_COUNT = Number(process.env.MEDIATOR_COUNT || 6);
    const gasBufferEth = String(process.env.MEDIATOR_GAS_BUFFER_ETH || '0.01');
    const gasBufferWei = ethers.parseEther(gasBufferEth);
    const totalNeeded = stakeWei * BigInt(MEDIATOR_COUNT) + gasBufferWei * BigInt(MEDIATOR_COUNT) + ethers.parseEther('0.02');
    if (balance < totalNeeded) {
      console.error(`❌ Insufficient balance. Need ~${ethers.formatEther(totalNeeded)} ETH`);
      process.exit(1);
    }

    // 3. Build mediator wallets
    // Prefer deterministic wallets for reproducible tests. Use either:
    // - SEED_MNEMONIC env var to derive wallets, or
    // - LOCAL_NODE=true to use unlocked local node signers (no funding needed), or
    // - fallback to random wallets for one-off manual runs.
    const mediatorWallets = [];
    const seedMnemonic = process.env.SEED_MNEMONIC;
    const useLocalNode = envFlag('LOCAL_NODE', false);
    const allowInsecureDeterministic = envFlag('ALLOW_INSECURE_DETERMINISTIC', false);

    if (seedMnemonic && !isLocalChain && !allowInsecureDeterministic) {
      console.error('❌ Refusing to use SEED_MNEMONIC on public/non-local chain.');
      console.error('   This is unsafe and bots can drain deterministic wallets instantly.');
      console.error('   Fix options:');
      console.error('   1) unset SEED_MNEMONIC to use random ephemeral wallets');
      console.error('   2) set LOCAL_NODE=true for local testing');
      console.error('   3) set ALLOW_INSECURE_DETERMINISTIC=true only if you fully accept the risk');
      process.exit(1);
    }

    if (useLocalNode) {
      // Use unlocked accounts from a local node (Hardhat/Anvil). We'll obtain signers later when registering.
      console.log('⚙️ Using local node unlocked signers for mediators (LOCAL_NODE=true)');
      // create placeholder addresses by asking the provider for accounts
      const accounts = await provider.send('eth_accounts', []);
      if (!accounts || accounts.length < MEDIATOR_COUNT) {
        console.error(`❌ Local node does not expose enough unlocked accounts (need ${MEDIATOR_COUNT}).`);
        process.exit(1);
      }
      for (let i = 0; i < MEDIATOR_COUNT; i++) {
        // provider.getSigner(i) will be used when sending txs
        mediatorWallets.push({ localIndex: i, address: accounts[i] });
        console.log(`\n🎲 Mediator ${i + 1} address (local): ${accounts[i]}`);
      }
    } else if (seedMnemonic) {
      console.log('⚙️ Deriving deterministic mediator wallets from SEED_MNEMONIC');
      for (let i = 0; i < MEDIATOR_COUNT; i++) {
        const path = `m/44'/60'/0'/0/${i}`;
        const w = ethers.HDNodeWallet.fromPhrase(seedMnemonic, undefined, path);
        mediatorWallets.push(w);
        console.log(`\n🎲 Mediator ${i + 1} address: ${w.address}`);
      }
    } else {
      console.log('⚠️ No mnemonic provided: falling back to random wallets (non-deterministic)');
      for (let i = 0; i < MEDIATOR_COUNT; i++) {
        const randomWallet = ethers.Wallet.createRandom();
        mediatorWallets.push(randomWallet);
        console.log(`\n🎲 Mediator ${i + 1}:`);
        console.log(`   Address:     ${randomWallet.address}`);
        console.log(`   Private Key: ${randomWallet.privateKey}`);
        console.log(`   ⚠️  SAVE THIS KEY! It won't be shown again.`);
      }
    }

    // 4. Fund + register từng mediator ngay lập tức để giảm thời gian ví có ETH rảnh
    console.log(`\n\n📝 Registering ${MEDIATOR_COUNT} mediators on-chain (stake = required stake)...`);
    const fundAmount = stakeWei + gasBufferWei;
    
    for (let i = 0; i < mediatorWallets.length; i++) {
      const mw = mediatorWallets[i];
      let mediatorContract;
      let addr;

      if (mw.localIndex !== undefined) {
        // use provider.getSigner for local unlocked account
        const signer = await provider.getSigner(mw.localIndex);
        mediatorContract = new ethers.Contract(MEDIATOR_POOL, MEDIATOR_POOL_ABI, signer);
        addr = mw.address;
      } else {
        const mediatorWallet = mw.connect(provider);
        mediatorContract = new ethers.Contract(MEDIATOR_POOL, MEDIATOR_POOL_ABI, mediatorWallet);
        addr = mediatorWallet.address;

        console.log(`\n[${i + 1}/${mediatorWallets.length}] 📤 Funding mediator (${addr}) with ${ethers.formatEther(fundAmount)} ETH...`);
        const fundTx = await signerWallet.sendTransaction({
          to: addr,
          value: fundAmount
        });
        console.log(`      ⏳ Fund tx: ${fundTx.hash}`);
        await fundTx.wait();

        const fundedBalance = await provider.getBalance(addr);
        if (fundedBalance < stakeWei) {
          console.error(`      ❌ Funded balance too low: ${ethers.formatEther(fundedBalance)} ETH`);
          console.error('      Possible cause: deterministic/private key leaked and bot drained funds.');
          continue;
        }
      }

      console.log(`\n[${i + 1}/${mediatorWallets.length}] 🔐 Registering mediator (${addr})...`);

      try {
        const tx = await mediatorContract.registerAsMediator({ value: stakeWei });
        console.log(`      ⏳ Tx hash: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
          console.log(`      ✅ Registered with stake: ${stakeETH} ETH`);
          console.log(`      Block: ${receipt.blockNumber}`);

          try {
            // Fetch block to get timestamp for registeredAt
            const block = await provider.getBlock(receipt.blockNumber);
            const registeredAt = new Date(block.timestamp * 1000);

            // Upsert into DB (create user if not exists, mark as mediator)
            await prisma.user.upsert({
              where: { walletAddress: addr.toLowerCase() },
              update: {
                isMediator: true,
                mediatorStake: stakeETH,
                mediatorRegisteredAt: registeredAt,
                role: 'MEDIATOR'
              },
              create: {
                walletAddress: addr.toLowerCase(),
                role: 'MEDIATOR',
                isMediator: true,
                mediatorStake: stakeETH,
                mediatorRegisteredAt: registeredAt
              }
            });

            console.log('      📦 Upserted mediator into DB');
          } catch (dbErr) {
            console.error('      ⚠️ DB upsert failed:', dbErr?.message || dbErr);
          }
        } else {
          console.error(`      ❌ Transaction failed`);
        }
      } catch (error) {
        console.error(`      ❌ Error:`, error.message);
        if (isInsufficientFundsError(error)) {
          console.error('      Hint: wallet had insufficient funds at register time (possibly drained or underfunded).');
          console.error('      Recommendation: use LOCAL_NODE=true or random wallets (unset SEED_MNEMONIC).');
        }
      }
    }

    // 5. Verify all mediators registered
    console.log('\n\n✅ Verifying registration...');
    const allMediators = await contract.getAllMediators();
    console.log(`Total mediators in pool: ${allMediators.length}`);
    
    allMediators.forEach((m, idx) => {
      console.log(`\n  Mediator ${idx + 1}:`);
      console.log(`    Wallet: ${m.wallet}`);
      console.log(`    Stake: ${ethers.formatEther(m.stakeAmount)} ETH`);
      console.log(`    Active: ${m.isActive}`);
      console.log(`    Reputation: ${m.reputationScore}`);
      console.log(`    Total votes: ${m.totalVotes}`);
    });

    console.log(`\n✨ Seeding ${MEDIATOR_COUNT} mediators complete!`);
    try {
      await prisma.$disconnect();
      console.log('🔌 Prisma disconnected');
    } catch (dErr) {
      console.warn('⚠️ Error disconnecting Prisma:', dErr?.message || dErr);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
})();
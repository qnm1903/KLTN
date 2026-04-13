#!/usr/bin/env node

/**
 * Export Hardhat test accounts in a clean format
 * Usage: node scripts/export-test-accounts.js
 */

const hre = require('hardhat');

async function exportAccounts() {
  const accounts = await hre.ethers.getSigners();
  
  const roles = ['Buyer', 'Seller', 'Mediator1', 'Mediator2', 'Mediator3', 'Mediator4', 'Mediator5'];
  
  console.log('\n' + '='.repeat(80));
  console.log('7 TEST ACCOUNTS - HARDHAT LOCAL NODE');
  console.log('='.repeat(80) + '\n');
  
  console.log('Network: http://localhost:8545');
  console.log('ChainID: 31337 (Hardhat)\n');
  
  for (let i = 0; i < 7; i++) {
    const account = accounts[i];
    const address = await account.getAddress();
    const privKey = await hre.ethers.provider.getBalance(address);
    
    // Get private key from account
    const wallet = new hre.ethers.Wallet(account.privateKey);
    
    console.log(`\n[${i}] ${roles[i].toUpperCase()}`);
    console.log(`    Address: ${address}`);
    console.log(`    Balance: ${hre.ethers.formatEther(privKey)} ETH`);
    
    // Private key is stored differently, use hardhat's default accounts
    console.log(`    Private Key (copy for MetaMask import):`);
    console.log(`    ${account.privateKey}\n`);
  }
  
  // Also output as JSON for script usage
  const accountsJson = {
    timestamp: new Date().toISOString(),
    network: 'http://localhost:8545',
    chainId: 31337,
    accounts: []
  };
  
  for (let i = 0; i < 7; i++) {
    const account = accounts[i];
    const address = await account.getAddress();
    accountsJson.accounts.push({
      index: i,
      role: roles[i],
      address: address,
      privateKey: account.privateKey
    });
  }
  
  console.log('='.repeat(80));
  console.log('\nJSON Export (for scripts):');
  console.log(JSON.stringify(accountsJson, null, 2));
  console.log('\n' + '='.repeat(80) + '\n');
}

exportAccounts().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

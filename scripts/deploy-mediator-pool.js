const { ethers, upgrades } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying MediatorPool with account:', deployer.address);

  // Get VRF Coordinator address from env
  const vrfCoordinator = process.env.VRF_COORDINATOR;
  if (!vrfCoordinator) {
    throw new Error('VRF_COORDINATOR env variable is required');
  }

  // Get VRF config from env
  let subscriptionId = process.env.VRF_SUBSCRIPTION_ID;
  const keyHash = process.env.VRF_KEY_HASH;
  const callbackGasLimit = process.env.VRF_CALLBACK_GAS_LIMIT || '2500000';

  if (!subscriptionId) {
    throw new Error('VRF_SUBSCRIPTION_ID env variable is required');
  }
  if (!keyHash) {
    throw new Error('VRF_KEY_HASH env variable is required');
  }

  // Convert subscription ID to BigInt to handle large uint256 values (VRF v2.5)
  subscriptionId = ethers.toBigInt(subscriptionId);

  console.log('\nVRF Configuration (v2.5):');
  console.log('  VRF Coordinator:', vrfCoordinator);
  console.log('  Subscription ID (uint256):', subscriptionId.toString());
  console.log('  Key Hash:', keyHash);
  console.log('  Callback Gas Limit:', callbackGasLimit);

  const MediatorPool = await ethers.getContractFactory('MediatorPool');

  // Deploy proxy with explicit unsafeAllow flags to suppress the warning
  // Note: For VRF v2.5, subscriptionId is now uint256 (not uint64)
  const proxy = await upgrades.deployProxy(
    MediatorPool,
    [subscriptionId, keyHash, callbackGasLimit], // ← subscriptionId as BigInt (uint256), keyHash, callbackGasLimit
    {
      initializer: 'initialize',
      constructorArgs: [vrfCoordinator],
      unsafeAllow: ['constructor', 'state-variable-immutable'],
    }
  );

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log('\n✅ MediatorPool Proxy deployed to:', proxyAddress);
  console.log('✅ MediatorPool Implementation deployed to:', implementationAddress);

  console.log('\n🚨 IMPORTANT NEXT STEPS:');
  console.log('   1. Go to https://vrf.chain.link/sepolia');
  console.log('   2. Find your subscription (ID: ' + subscriptionId + ')');
  console.log('   3. Click "Add Consumer"');
  console.log('   4. Paste this address: ' + proxyAddress);
  console.log('   5. Approve & submit');

  console.log('\n📋 Add to .env:');
  console.log('   MEDIATOR_POOL_CONTRACT=' + proxyAddress);

  // Verify on Etherscan
  console.log('\nTo verify on Etherscan:');
  console.log(`npx hardhat verify --network sepolia ${implementationAddress} ${vrfCoordinator}`);
  console.log(`npx hardhat verify --network sepolia ${proxyAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
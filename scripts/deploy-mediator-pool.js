const { ethers, upgrades } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying MediatorPool with account:', deployer.address);

  // Get VRF Coordinator address from env or prompt
  const vrfCoordinator = process.env.VRF_COORDINATOR;
  if (!vrfCoordinator) {
    throw new Error('VRF_COORDINATOR env variable is required');
  }

  const MediatorPool = await ethers.getContractFactory('MediatorPool');

  // Deploy proxy with explicit unsafeAllow flags to suppress the warning
  // This is safe because:
  // 1. The constructor only sets an immutable VRF coordinator address
  // 2. It calls _disableInitializers() to prevent direct initialization
  const proxy = await upgrades.deployProxy(
    MediatorPool,
    [1, ethers.ZeroHash, 2500000], // subscriptionId, keyHash, callbackGasLimit
    {
      initializer: 'initialize',
      constructorArgs: [vrfCoordinator],
      unsafeAllow: ['constructor', 'state-variable-immutable'],
    }
  );

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log('MediatorPool Proxy deployed to:', proxyAddress);
  console.log('MediatorPool Implementation deployed to:', implementationAddress);

  // Verify on Etherscan (if supported)
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

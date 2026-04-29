const { ethers, upgrades } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying MediatorPool (Mock VRF) with account:', deployer.address);

  // Deploy mock VRF coordinator for local testing
  const MockVRFCoordinator = await ethers.getContractFactory('MockVRFCoordinator');
  const mockVrf = await MockVRFCoordinator.deploy();
  await mockVrf.waitForDeployment();
  console.log('MockVRFCoordinator deployed to:', await mockVrf.getAddress());

  const MediatorPool = await ethers.getContractFactory('MediatorPool');

  const proxy = await upgrades.deployProxy(
    MediatorPool,
    [1, ethers.ZeroHash, 2500000], // subscriptionId=1, keyHash=0x00, callbackGasLimit=2.5M
    {
      initializer: 'initialize',
      constructorArgs: [await mockVrf.getAddress()],
      unsafeAllow: ['constructor', 'state-variable-immutable'],
    }
  );

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log('\nMediatorPool Proxy deployed to:', proxyAddress);
  console.log('MediatorPool Implementation deployed to:', implAddress);
  console.log('\nAdd to .env:');
  console.log(`MEDIATOR_POOL_CONTRACT=${proxyAddress}`);
  console.log(`VRF_COORDINATOR=${await mockVrf.getAddress()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

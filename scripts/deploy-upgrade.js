const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  if (network.chainId !== 11155111n) {
    throw new Error(`Expected Sepolia (11155111), got ${network.chainId.toString()}`);
  }

  console.log("Upgrading MediatorPool with account:", deployer.address);
  console.log("Network:", hre.network.name, "ChainId:", network.chainId.toString());

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", hre.ethers.formatEther(balance), "ETH");

  const MEDIATOR_POOL_ADDRESS = process.env.MEDIATOR_POOL_CONTRACT;
  console.log("Upgrading MediatorPool at:", MEDIATOR_POOL_ADDRESS);

  const vrfCoordinator = process.env.VRF_COORDINATOR;
  if (!vrfCoordinator) {
    throw new Error("VRF_COORDINATOR env variable is required");
  }

  const MediatorPool = await hre.ethers.getContractFactory("MediatorPool");
  
  console.log("⏳ Importing existing proxy into OpenZeppelin tracking...");
  try {
    await hre.upgrades.forceImport(MEDIATOR_POOL_ADDRESS, MediatorPool, {
      kind: "uups",
      constructorArgs: [vrfCoordinator],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    });
    console.log("✅ Proxy imported successfully");
  } catch (error) {
    console.log("ℹ️  Proxy already tracked or error:", error.message);
  }
  
  console.log("⏳ Uploading new implementation...");
  const upgraded = await hre.upgrades.upgradeProxy(MEDIATOR_POOL_ADDRESS, MediatorPool, {
    constructorArgs: [vrfCoordinator],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  });
  
  const upgradeTx = upgraded.deploymentTransaction();
  const receipt = upgradeTx ? await upgradeTx.wait() : null;

  console.log("✅ MediatorPool upgraded successfully!");
  console.log("New implementation deployed at:", await upgraded.getAddress());
  if (receipt) {
    console.log("Upgrade tx hash:", upgradeTx.hash);
    console.log("Block number:", receipt.blockNumber);
  }

  const deploymentsPath = path.join(__dirname, "../deployments/sepolia.json");
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  
  deployments.contracts.MediatorPool = {
    address: MEDIATOR_POOL_ADDRESS,
    proxyType: "UUPS",
    upgradedAt: new Date().toISOString(),
    txHash: upgradeTx?.hash || null,
    blockNumber: receipt?.blockNumber || null
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("📝 Deployment info saved to deployments/sepolia.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

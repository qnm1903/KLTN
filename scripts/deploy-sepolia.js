const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  if (network.chainId !== 11155111n) {
    throw new Error(`Expected Sepolia (11155111), got ${network.chainId.toString()}`);
  }

  console.log("Deploying with account:", deployer.address);
  console.log("Network:", hre.network.name, "ChainId:", network.chainId.toString());

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", hre.ethers.formatEther(balance), "ETH");

  const EscrowFactory = await hre.ethers.getContractFactory("EscrowFactory");
  const factory = await EscrowFactory.deploy();
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  const deployTx = factory.deploymentTransaction();
  if (!deployTx) {
    throw new Error(
      "EscrowFactory deployment transaction is unavailable (deploymentTransaction() returned null). " +
      "Cannot determine tx hash/block metadata for this deployment."
    );
  }

  const receipt = await deployTx.wait();
  if (!receipt) {
    console.warn(
      "Deployment transaction receipt is null (possibly dropped/replaced). " +
      "Address is available from waitForDeployment(), but blockNumber metadata will be saved as null."
    );
  }

  const output = {
    network: hre.network.name,
    chainId: network.chainId.toString(),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      EscrowFactory: {
        address: factoryAddress,
        txHash: deployTx.hash,
        blockNumber: receipt ? receipt.blockNumber : null,
        constructorArgs: []
      }
    }
  };

  const outDir = path.join(__dirname, "..", "deployments");
  const outFile = path.join(outDir, "sepolia.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log("EscrowFactory deployed at:", factoryAddress);
  console.log("Deployment tx hash:", deployTx.hash);
  if (receipt) {
    console.log("Deployment block:", receipt.blockNumber);
  } else {
    console.log("Deployment block: unavailable (receipt is null)");
  }
  console.log("Deployment metadata saved to:", outFile);
  console.log("\nVerify command:");
  console.log(`npx hardhat verify --network sepolia ${factoryAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
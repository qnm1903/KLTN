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
  const receipt = await deployTx.wait();

  const output = {
    network: hre.network.name,
    chainId: network.chainId.toString(),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      EscrowFactory: {
        address: factoryAddress,
        txHash: deployTx.hash,
        blockNumber: receipt.blockNumber,
        constructorArgs: []
      }
    }
  };

  const outDir = path.join(__dirname, "..", "deployments");
  const outFile = path.join(outDir, "sepolia.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log("EscrowFactory deployed at:", factoryAddress);
  console.log("Deployment metadata saved to:", outFile);
  console.log("\nVerify command:");
  console.log(`npx hardhat verify --network sepolia ${factoryAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function verifyContract(address, constructorArguments) {
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments
    });
    console.log(`Verified: ${address}`);
  } catch (error) {
    if (error.message.toLowerCase().includes("already verified")) {
      console.log(`Already verified: ${address}`);
      return;
    }
    throw error;
  }
}

async function main() {
  const deploymentFile = path.join(__dirname, "..", "deployments", "sepolia.json");
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const factory = deployment.contracts?.EscrowFactory;

  if (!factory?.address) {
    throw new Error("EscrowFactory address is missing in deployments/sepolia.json");
  }

  console.log("Verifying EscrowFactory:", factory.address);
  await verifyContract(factory.address, factory.constructorArgs || []);
  console.log("Verification completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
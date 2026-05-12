const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  if (network.chainId !== 11155111n) {
    throw new Error(`Expected Sepolia (11155111), got ${network.chainId.toString()}`);
  }

  const MEDIATOR_POOL_ADDRESS = process.env.MEDIATOR_POOL_CONTRACT;
  if (!MEDIATOR_POOL_ADDRESS) {
    throw new Error("MEDIATOR_POOL_CONTRACT env variable is required");
  }

  const MediatorPool = await hre.ethers.getContractFactory("MediatorPool");
  const mediatorPool = MediatorPool.attach(MEDIATOR_POOL_ADDRESS);

  const toRemove = [
    "0x0819BF43884Ba7fe4C7A9494882FD4483949938E",
    "0x3cAdA0cbE99d3eA6f7e71782e7E6Ac5c0Ab4309c",
    "0xAeaEBb1ad3cD3C0E7A9b588652e3Db21f850c4E5",
    "0x7FfB800F07f568FAde846262f0622A0CbD319f72",
  ];

  console.log("Force removing mediators via slashForTimeout...");
  console.log("Admin:", deployer.address);
  console.log("MediatorPool:", MEDIATOR_POOL_ADDRESS);

  for (const mediator of toRemove) {
    console.log(`\n🔄 Removing ${mediator}`);
    for (let i = 1; i <= 3; i++) {
      try {
        const tx = await mediatorPool.slashForTimeout(mediator);
        console.log(`  ⏳ slashForTimeout #${i} tx: ${tx.hash}`);
        const receipt = await tx.wait(1);
        console.log(`  ✅ confirmed in block ${receipt.blockNumber}`);
      } catch (error) {
        console.log(`  ❌ failed on attempt ${i}: ${error.message}`);
        break;
      }
    }
  }

  const remaining = await mediatorPool.getAllMediators();
  console.log(`\nRemaining mediators: ${remaining.length}`);
  remaining.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.wallet}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

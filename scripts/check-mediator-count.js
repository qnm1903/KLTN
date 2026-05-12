const hre = require("hardhat");

async function main() {
  const MEDIATOR_POOL_ADDRESS = process.env.MEDIATOR_POOL_CONTRACT || "0xb3585dD66a67081f0558e3858ca8925a9e88036C";

  const MediatorPool = await hre.ethers.getContractFactory("MediatorPool");
  const mediatorPool = MediatorPool.attach(MEDIATOR_POOL_ADDRESS);

  const mediators = await mediatorPool.getAllMediators();
  console.log(`Mediator count: ${mediators.length}`);
  mediators.forEach((m, index) => {
    console.log(`${index + 1}. ${m.wallet}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

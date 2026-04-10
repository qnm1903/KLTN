const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

describe("MultiSigEscrow Benchmark", function () {
  let vault;
  let owner, buyer, seller, mediator1, mediator2, mediator3, mediator4, mediator5;

  const AMOUNT = ethers.parseEther("1.0");
  const CONFIRM_DAYS = 14;
  const TIMEOUT_DAYS = 21;

  beforeEach(async function () {
    [owner, buyer, seller, mediator1, mediator2, mediator3, mediator4, mediator5] = await ethers.getSigners();

    const escrowId = ethers.id("test-multisig");
    const mediators = [
      mediator1.address,
      mediator2.address,
      mediator3.address,
      mediator4.address,
      mediator5.address
    ];

    const MultiSigEscrow = await ethers.getContractFactory("MultiSigEscrow");
    vault = await MultiSigEscrow.deploy(
      escrowId,
      buyer.address,
      seller.address,
      mediators,
      AMOUNT,
      CONFIRM_DAYS,
      TIMEOUT_DAYS
    );
  });

  describe("Happy Path: Release", function () {
    it("Should release after buyer and seller sign", async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });

      // Signatures
      const tx1 = await vault.connect(buyer).signRelease();
      console.log(`\t[Metric] Payload size for MultiSig signRelease() (Buyer): ${ethers.getBytes(tx1.data).length} bytes`);

      const tx2 = await vault.connect(seller).signRelease();
      await tx2.wait();

      await vault.connect(mediator1).signRelease();
      await vault.connect(mediator2).signRelease();

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      const tx3 = await vault.connect(mediator3).signRelease();
      const receipt = await tx3.wait();
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

      console.log(`\t[Metric] Payload size for MultiSig signRelease() (Seller): ${ethers.getBytes(tx2.data).length} bytes`);
      console.log(`\t[Metric] Payload size for MultiSig signRelease() (Mediator 3): ${ethers.getBytes(tx3.data).length} bytes`);
      console.log(`\t[Metric] Total MultiSig Payload size (5 txs): ${ethers.getBytes(tx1.data).length + ethers.getBytes(tx2.data).length + ethers.getBytes(tx3.data).length} bytes`);

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(AMOUNT);
      expect(await vault.status()).to.equal(2); // RELEASED
    });
  });

  describe("Dispute & Refund", function () {
    it("Should refund after dispute, buyer, and mediator sign", async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });

      await vault.connect(buyer).dispute();

      await vault.connect(mediator1).signRefund();
      await vault.connect(mediator2).signRefund();
      await vault.connect(mediator3).signRefund();
      await vault.connect(mediator4).signRefund();

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await vault.connect(buyer).signRefund();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

      expect(buyerBalanceAfter - buyerBalanceBefore + gasCost).to.equal(AMOUNT);
      expect(await vault.status()).to.equal(3); // REFUNDED
    });
  });

  describe("Timeout Path", function () {
    it("Should timeout release after seller and mediator sign", async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });

      await time.increase(TIMEOUT_DAYS * 24 * 60 * 60 + 1);

      await vault.connect(seller).signTimeout();
      await vault.connect(mediator1).signTimeout();
      await vault.connect(mediator2).signTimeout();
      await vault.connect(mediator3).signTimeout();
      await vault.connect(mediator4).signTimeout();

      expect(await vault.status()).to.equal(2); // RELEASED
    });
  });
});
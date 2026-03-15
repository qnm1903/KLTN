const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

describe("EscrowVault & EscrowFactory", function () {
  let factory, vault;
  let owner, buyer, seller, mediator, otherAccount;
  let pkAggWallet; // Represents the aggregated DKG key for testing

  const AMOUNT = ethers.parseEther("1.0");
  const CONFIRM_DAYS = 14;
  const TIMEOUT_DAYS = 21;

  beforeEach(async function () {
    [owner, buyer, seller, mediator, otherAccount] = await ethers.getSigners();

    // Create a random wallet to simulate the aggregate DKG key
    pkAggWallet = ethers.Wallet.createRandom();

    // Deploy Factory
    const Factory = await ethers.getContractFactory("EscrowFactory");
    factory = await Factory.deploy();

    // Create Escrow
    const tx = await factory.connect(buyer).createEscrow(
      seller.address,
      mediator.address,
      pkAggWallet.address,
      AMOUNT,
      CONFIRM_DAYS,
      TIMEOUT_DAYS
    );
    const receipt = await tx.wait();

    // Find EscrowCreatedEvent to get vault address
    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "EscrowCreatedEvent"
    );
    const vaultAddress = event.args[0];

    // Get vault instance
    vault = await ethers.getContractAt("EscrowVault", vaultAddress);
  });

  describe("Deployment", function () {
    it("Should set the right buyer, seller, and mediator", async function () {
      expect(await vault.buyer()).to.equal(buyer.address);
      expect(await vault.seller()).to.equal(seller.address);
      expect(await vault.mediator()).to.equal(mediator.address);
    });

    it("Should start with CREATED status", async function () {
      expect(await vault.status()).to.equal(0); // 0 = CREATED
    });
  });

  describe("Locking Funds", function () {
    it("Should allow buyer to lock funds", async function () {
      await expect(vault.connect(buyer).lockFunds({ value: AMOUNT }))
        .to.emit(vault, "FundsLocked")
        .withArgs(await vault.escrowId(), AMOUNT);

      expect(await vault.status()).to.equal(1); // 1 = LOCKED
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(AMOUNT);
    });

    it("Should reject if anyone else tries to lock", async function () {
      await expect(vault.connect(seller).lockFunds({ value: AMOUNT }))
        .to.be.revertedWith("Only buyer can lock");
    });

    it("Should reject if value is incorrect", async function () {
      await expect(vault.connect(buyer).lockFunds({ value: ethers.parseEther("0.5") }))
        .to.be.revertedWith("Incorrect value");
    });
  });

  describe("Happy Path: Release", function () {
    beforeEach(async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });
    });

    it("Should release funds to seller with valid signature", async function () {
      // Create message hash: keccak256(abi.encodePacked(escrowId, "release"))
      const escrowId = await vault.escrowId();
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "release"]);
      const msgHash = ethers.keccak256(payload);

      // Sign the raw message hash without EIP-191 prefix to match Solidity's ecrecover exactly
      // ethers.SigningKey can sign a digest directly
      const signingKey = new ethers.SigningKey(pkAggWallet.privateKey);
      const signature = signingKey.sign(msgHash);

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);

      const tx = await vault.release(signature.r, signature.s, signature.v, msgHash);
      const receipt = await tx.wait();
      
      console.log(`\t[Metric] Payload size for TSS release(): ${ethers.getBytes(tx.data).length} bytes`);

      await expect(tx)
        .to.emit(vault, "FundsReleased")
        .withArgs(escrowId, seller.address);

      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(AMOUNT);
      expect(await vault.status()).to.equal(2); // 2 = RELEASED
    });

    it("Should revert with invalid signature", async function () {
      const escrowId = await vault.escrowId();
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "release"]);
      const msgHash = ethers.keccak256(payload);

      // Sign with WRONG key
      const wrongWallet = ethers.Wallet.createRandom();
      const signingKey = new ethers.SigningKey(wrongWallet.privateKey);
      const signature = signingKey.sign(msgHash);

      await expect(vault.release(signature.r, signature.s, signature.v, msgHash))
        .to.be.revertedWith("Invalid signature");
    });

    it("Should revert if action string is tampered", async function () {
      const escrowId = await vault.escrowId();
      // Sign "refund" instead of "release"
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "refund"]);
      const tamperedHash = ethers.keccak256(payload);

      const signingKey = new ethers.SigningKey(pkAggWallet.privateKey);
      const signature = signingKey.sign(tamperedHash);

      // Calling release() expects hash of "release"
      await expect(vault.release(signature.r, signature.s, signature.v, tamperedHash))
        .to.be.revertedWith("Invalid msgHash");
    });
  });

  describe("Dispute & Refund", function () {
    beforeEach(async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });
    });

    it("Should allow buyer to open dispute and then refund", async function () {
      const escrowId = await vault.escrowId();

      // Open Dispute
      await expect(vault.connect(buyer).dispute())
        .to.emit(vault, "DisputeOpened")
        .withArgs(escrowId);
      expect(await vault.status()).to.equal(4); // 4 = DISPUTED

      // Refund
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "refund"]);
      const msgHash = ethers.keccak256(payload);
      const signingKey = new ethers.SigningKey(pkAggWallet.privateKey);
      const signature = signingKey.sign(msgHash);

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

      const tx = await vault.connect(buyer).refund(signature.r, signature.s, signature.v, msgHash);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

      expect(buyerBalanceAfter - buyerBalanceBefore + gasCost).to.equal(AMOUNT);
      expect(await vault.status()).to.equal(3); // 3 = REFUNDED
    });
  });

  describe("Timeout Path", function () {
    beforeEach(async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });
    });

    it("Should not allow timeout release before deadline", async function () {
      const escrowId = await vault.escrowId();
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "timeout"]);
      const msgHash = ethers.keccak256(payload);
      const signingKey = new ethers.SigningKey(pkAggWallet.privateKey);
      const signature = signingKey.sign(msgHash);

      await expect(vault.timeoutRelease(signature.r, signature.s, signature.v, msgHash))
        .to.be.revertedWith("Not timed out");
    });

    it("Should allow timeout release after deadline", async function () {
      const escrowId = await vault.escrowId();
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "timeout"]);
      const msgHash = ethers.keccak256(payload);
      const signingKey = new ethers.SigningKey(pkAggWallet.privateKey);
      const signature = signingKey.sign(msgHash);

      // Fast forward time
      await time.increase(TIMEOUT_DAYS * 24 * 60 * 60 + 1);

      await expect(vault.timeoutRelease(signature.r, signature.s, signature.v, msgHash))
        .to.emit(vault, "FundsReleased")
        .withArgs(escrowId, seller.address);
    });
  });
});
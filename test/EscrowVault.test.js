const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

describe("EscrowVault & EscrowFactory", function () {
  let factory, vault;
  let owner, buyer, seller, mediator, otherAccount;
  let laneSigners;
  let lanePk;

  const AMOUNT = ethers.parseEther("1.0");
  const CONFIRM_DAYS = 14;
  const TIMEOUT_DAYS = 21;
  const ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

  function mulmod(a, b, m) {
    return (a * b) % m;
  }

  function toPublicXY(privateKey) {
    const pub = ethers.SigningKey.computePublicKey(privateKey, false); // 0x04 + x + y
    return {
      x: "0x" + pub.slice(4, 68),
      y: "0x" + pub.slice(68, 132)
    };
  }

  function buildSchnorrSignature(privateKey, pkX, pkY, msgHash) {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const noncePub = ethers.SigningKey.computePublicKey(nonce, false);
    const R_x = "0x" + noncePub.slice(4, 68);
    const R_y = "0x" + noncePub.slice(68, 132);
    const R_addr = ethers.computeAddress("0x04" + R_x.slice(2) + R_y.slice(2));

    const e = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "bytes32"],
      [R_addr, pkX, pkY, msgHash]
    );

    const k = BigInt(nonce);
    const s = BigInt(privateKey);
    const ev = BigInt(e);
    const z = (k + (ev * s) % ORDER) % ORDER;

    return {
      R_addr,
      z: ethers.toBeHex(z, 32),
      e
    };
  }

  beforeEach(async function () {
    [owner, buyer, seller, mediator, otherAccount] = await ethers.getSigners();

    laneSigners = {
      release: ethers.Wallet.createRandom(),
      refund: ethers.Wallet.createRandom(),
      timeout: ethers.Wallet.createRandom()
    };
    lanePk = {
      release: toPublicXY(laneSigners.release.privateKey),
      refund: toPublicXY(laneSigners.refund.privateKey),
      timeout: toPublicXY(laneSigners.timeout.privateKey)
    };

    // Deploy Factory
    const Factory = await ethers.getContractFactory("EscrowFactory");
    factory = await Factory.deploy();

    // Create Escrow
    const tx = await factory.connect(buyer).createEscrow(
      seller.address,
      mediator.address,
      [
        BigInt(lanePk.release.x),
        BigInt(lanePk.release.y),
        BigInt(lanePk.refund.x),
        BigInt(lanePk.refund.y),
        BigInt(lanePk.timeout.x),
        BigInt(lanePk.timeout.y)
      ],
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
      const signature = buildSchnorrSignature(
        laneSigners.release.privateKey,
        lanePk.release.x,
        lanePk.release.y,
        msgHash
      );

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);

      const tx = await vault.release(signature.R_addr, signature.z, signature.e, msgHash);
      await tx.wait();
      
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
      const wrongWallet = ethers.Wallet.createRandom();
      const signature = buildSchnorrSignature(
        wrongWallet.privateKey,
        lanePk.release.x,
        lanePk.release.y,
        msgHash
      );

      await expect(vault.release(signature.R_addr, signature.z, signature.e, msgHash))
        .to.be.revertedWith("Invalid signature");
    });

    it("Should reject release signed with refund lane key", async function () {
      const escrowId = await vault.escrowId();
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "release"]);
      const msgHash = ethers.keccak256(payload);

      const wrongLaneSig = buildSchnorrSignature(
        laneSigners.refund.privateKey,
        lanePk.refund.x,
        lanePk.refund.y,
        msgHash
      );

      await expect(vault.release(wrongLaneSig.R_addr, wrongLaneSig.z, wrongLaneSig.e, msgHash))
        .to.be.revertedWith("Invalid signature");
    });

    it("Should revert if action string is tampered", async function () {
      const escrowId = await vault.escrowId();
      // Sign "refund" instead of "release"
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "refund"]);
      const tamperedHash = ethers.keccak256(payload);
      const signature = buildSchnorrSignature(
        laneSigners.release.privateKey,
        lanePk.release.x,
        lanePk.release.y,
        tamperedHash
      );

      // Calling release() expects hash of "release"
      await expect(vault.release(signature.R_addr, signature.z, signature.e, tamperedHash))
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
      const signature = buildSchnorrSignature(
        laneSigners.refund.privateKey,
        lanePk.refund.x,
        lanePk.refund.y,
        msgHash
      );

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

      const tx = await vault.connect(buyer).refund(signature.R_addr, signature.z, signature.e, msgHash);
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
      const signature = buildSchnorrSignature(
        laneSigners.timeout.privateKey,
        lanePk.timeout.x,
        lanePk.timeout.y,
        msgHash
      );

      await expect(vault.timeoutRelease(signature.R_addr, signature.z, signature.e, msgHash))
        .to.be.revertedWith("Not timed out");
    });

    it("Should allow timeout release after deadline", async function () {
      const escrowId = await vault.escrowId();
      const payload = ethers.solidityPacked(["bytes32", "string"], [escrowId, "timeout"]);
      const msgHash = ethers.keccak256(payload);
      const signature = buildSchnorrSignature(
        laneSigners.timeout.privateKey,
        lanePk.timeout.x,
        lanePk.timeout.y,
        msgHash
      );

      // Fast forward time
      await time.increase(TIMEOUT_DAYS * 24 * 60 * 60 + 1);

      await expect(vault.timeoutRelease(signature.R_addr, signature.z, signature.e, msgHash))
        .to.emit(vault, "FundsReleased")
        .withArgs(escrowId, seller.address);
    });
  });
});
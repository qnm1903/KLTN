const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

describe("EscrowVault & EscrowFactory (5-of-7)", function () {
  let factory;
  let vault;
  let owner;
  let buyer;
  let seller;
  let mediator1;
  let mediator2;
  let mediator3;
  let mediator4;
  let mediator5;
  let otherAccount;
  let mediatorCommittee;
  let aggSigner;
  let aggPk;

  const AMOUNT = ethers.parseEther("1.0");
  const CONFIRM_DAYS = 14;
  const TIMEOUT_DAYS = 21;
  const ORDER = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

  const BITMAP_RELEASE = 0x1f;
  const BITMAP_REFUND = 0x3e;
  const BITMAP_TIMEOUT = 0x3d;

  function toPublicXY(privateKey) {
    const pub = ethers.SigningKey.computePublicKey(privateKey, false);
    return {
      x: "0x" + pub.slice(4, 68),
      y: "0x" + pub.slice(68, 132)
    };
  }

  function buildSchnorrSignature(privateKey, pkX, pkY, msgHash) {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const noncePub = ethers.SigningKey.computePublicKey(nonce, false);
    const rX = "0x" + noncePub.slice(4, 68);
    const rY = "0x" + noncePub.slice(68, 132);
    const rAddr = ethers.computeAddress("0x04" + rX.slice(2) + rY.slice(2));

    const e = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "bytes32"],
      [rAddr, pkX, pkY, msgHash]
    );

    const k = BigInt(nonce);
    const s = BigInt(privateKey);
    const ev = BigInt(e);
    const z = (k + (ev * s) % ORDER) % ORDER;

    return {
      rAddr,
      z: ethers.toBeHex(z, 32),
      e
    };
  }

  async function deployEscrow(committee = mediatorCommittee) {
    const tx = await factory.connect(buyer).createEscrow(
      seller.address,
      committee,
      [BigInt(aggPk.x), BigInt(aggPk.y)],
      AMOUNT,
      CONFIRM_DAYS,
      TIMEOUT_DAYS
    );
    const receipt = await tx.wait();

    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "EscrowCreatedEvent"
    );
    const vaultAddress = event.args[0];
    vault = await ethers.getContractAt("EscrowVault", vaultAddress);
  }

  async function buildActionHashForDomain(action, signerBitmap, chainId, contractAddress) {
    const escrowId = await vault.escrowId();
    return ethers.solidityPackedKeccak256(
      ["uint256", "address", "bytes32", "string", "uint8"],
      [chainId, contractAddress, escrowId, action, signerBitmap]
    );
  }

  async function buildActionHash(action, signerBitmap) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return buildActionHashForDomain(action, signerBitmap, chainId, await vault.getAddress());
  }

  async function signAction(action, signerBitmap, signingWallet = aggSigner) {
    const msgHash = await buildActionHash(action, signerBitmap);
    const sig = buildSchnorrSignature(signingWallet.privateKey, aggPk.x, aggPk.y, msgHash);
    return {
      msgHash,
      rAddr: sig.rAddr,
      z: sig.z,
      e: sig.e
    };
  }

  beforeEach(async function () {
    [owner, buyer, seller, mediator1, mediator2, mediator3, mediator4, mediator5, otherAccount] =
      await ethers.getSigners();

    mediatorCommittee = [
      mediator1.address,
      mediator2.address,
      mediator3.address,
      mediator4.address,
      mediator5.address
    ];

    aggSigner = ethers.Wallet.createRandom();
    aggPk = toPublicXY(aggSigner.privateKey);

    const Factory = await ethers.getContractFactory("EscrowFactory");
    factory = await Factory.deploy();

    await deployEscrow();
  });

  describe("Deployment and participant guardrails", function () {
    it("sets buyer, seller and all five mediators", async function () {
      expect(await vault.buyer()).to.equal(buyer.address);
      expect(await vault.seller()).to.equal(seller.address);
      expect(await vault.mediators(0)).to.equal(mediator1.address);
      expect(await vault.mediators(1)).to.equal(mediator2.address);
      expect(await vault.mediators(2)).to.equal(mediator3.address);
      expect(await vault.mediators(3)).to.equal(mediator4.address);
      expect(await vault.mediators(4)).to.equal(mediator5.address);
      expect(await vault.status()).to.equal(0n);
    });

    it("rejects duplicate mediator in factory", async function () {
      const duplicated = [
        mediator1.address,
        mediator1.address,
        mediator3.address,
        mediator4.address,
        mediator5.address
      ];

      await expect(
        factory.connect(buyer).createEscrow(
          seller.address,
          duplicated,
          [BigInt(aggPk.x), BigInt(aggPk.y)],
          AMOUNT,
          CONFIRM_DAYS,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(factory, "DuplicateMediator");
    });

    it("rejects mediator collision with seller in factory", async function () {
      const conflictCommittee = [
        seller.address,
        mediator2.address,
        mediator3.address,
        mediator4.address,
        mediator5.address
      ];

      await expect(
        factory.connect(buyer).createEscrow(
          seller.address,
          conflictCommittee,
          [BigInt(aggPk.x), BigInt(aggPk.y)],
          AMOUNT,
          CONFIRM_DAYS,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(factory, "ParticipantConflict");
    });

    it("rejects invalid aggregate key coordinates in factory", async function () {
      await expect(
        factory.connect(buyer).createEscrow(
          seller.address,
          mediatorCommittee,
          [0, BigInt(aggPk.y)],
          AMOUNT,
          CONFIRM_DAYS,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(factory, "InvalidAggregateKey");
    });

    it("rejects off-curve aggregate key coordinates in factory", async function () {
      const offCurveY = BigInt(aggPk.y) + 1n;

      await expect(
        factory.connect(buyer).createEscrow(
          seller.address,
          mediatorCommittee,
          [BigInt(aggPk.x), offCurveY],
          AMOUNT,
          CONFIRM_DAYS,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(factory, "InvalidAggregateKey");
    });

    it("keeps defense-in-depth guardrail in vault constructor", async function () {
      const Vault = await ethers.getContractFactory("EscrowVault");
      const duplicated = [
        mediator1.address,
        mediator1.address,
        mediator3.address,
        mediator4.address,
        mediator5.address
      ];

      await expect(
        Vault.deploy(
          ethers.hexlify(ethers.randomBytes(32)),
          buyer.address,
          seller.address,
          duplicated,
          [BigInt(aggPk.x), BigInt(aggPk.y)],
          AMOUNT,
          CONFIRM_DAYS,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(Vault, "DuplicateMediator");
    });

    it("rejects invalid amount in vault constructor", async function () {
      const Vault = await ethers.getContractFactory("EscrowVault");

      await expect(
        Vault.deploy(
          ethers.hexlify(ethers.randomBytes(32)),
          buyer.address,
          seller.address,
          mediatorCommittee,
          [BigInt(aggPk.x), BigInt(aggPk.y)],
          0,
          CONFIRM_DAYS,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(Vault, "InvalidAmount");
    });

    it("rejects invalid deadline in vault constructor", async function () {
      const Vault = await ethers.getContractFactory("EscrowVault");

      await expect(
        Vault.deploy(
          ethers.hexlify(ethers.randomBytes(32)),
          buyer.address,
          seller.address,
          mediatorCommittee,
          [BigInt(aggPk.x), BigInt(aggPk.y)],
          AMOUNT,
          0,
          TIMEOUT_DAYS
        )
      ).to.be.revertedWithCustomError(Vault, "InvalidDeadline");
    });
  });

  describe("Signer bitmap helper", function () {
    it("counts set bits correctly", async function () {
      expect(await vault.signerCount(0x1f)).to.equal(5n);
      expect(await vault.signerCount(0x3f)).to.equal(6n);
      expect(await vault.signerCount(0x7f)).to.equal(7n);
    });

    it("validates signer policy matrix", async function () {
      expect(await vault.validateSignerBitmap(0x1f)).to.equal(true);
      expect(await vault.validateSignerBitmap(0x3d)).to.equal(true);
      expect(await vault.validateSignerBitmap(0x3e)).to.equal(true);
      expect(await vault.validateSignerBitmap(0x7f)).to.equal(true);

      expect(await vault.validateSignerBitmap(0x7c)).to.equal(false);
      expect(await vault.validateSignerBitmap(0x0f)).to.equal(false);
      expect(await vault.validateSignerBitmap(0x9f)).to.equal(false);
    });
  });

  describe("Locking funds", function () {
    it("allows buyer to lock funds", async function () {
      await expect(vault.connect(buyer).lockFunds({ value: AMOUNT }))
        .to.emit(vault, "FundsLocked")
        .withArgs(await vault.escrowId(), AMOUNT);

      expect(await vault.status()).to.equal(1n);
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(AMOUNT);
    });

    it("rejects non-buyer lock", async function () {
      await expect(vault.connect(seller).lockFunds({ value: AMOUNT }))
        .to.be.revertedWithCustomError(vault, "NotBuyer");
    });

    it("rejects wrong amount", async function () {
      await expect(vault.connect(buyer).lockFunds({ value: ethers.parseEther("0.5") }))
        .to.be.revertedWithCustomError(vault, "IncorrectValue");
    });
  });

  describe("Release path", function () {
    beforeEach(async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });
    });

    it("releases with valid 5-of-7 bitmap and signature", async function () {
      const sig = await signAction("release", BITMAP_RELEASE);
      const escrowId = await vault.escrowId();

      const tx = await vault.release(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_RELEASE);

      await expect(tx)
        .to.emit(vault, "FundsReleased")
        .withArgs(escrowId, seller.address, BigInt(BITMAP_RELEASE), "release");

      expect(await vault.status()).to.equal(2n);
    });

    it("rejects bitmap with no buyer/seller core role", async function () {
      const invalidBitmap = 0x7c;
      const sig = await signAction("release", invalidBitmap);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, sig.msgHash, invalidBitmap))
        .to.be.revertedWithCustomError(vault, "InvalidSignerBitmap");
    });

    it("rejects bitmap below 5 signers", async function () {
      const invalidBitmap = 0x0f;
      const sig = await signAction("release", invalidBitmap);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, sig.msgHash, invalidBitmap))
        .to.be.revertedWithCustomError(vault, "InvalidSignerBitmap");
    });

    it("rejects hash tampering by action mismatch", async function () {
      const sig = await signAction("refund", BITMAP_RELEASE);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_RELEASE))
        .to.be.revertedWithCustomError(vault, "InvalidMsgHash");
    });

    it("rejects hash tampering by signer bitmap mismatch", async function () {
      const sig = await signAction("release", BITMAP_RELEASE);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_REFUND))
        .to.be.revertedWithCustomError(vault, "InvalidMsgHash");
    });

    it("rejects domain tampering by contract address mismatch", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const forgedHash = await buildActionHashForDomain(
        "release",
        BITMAP_RELEASE,
        chainId,
        otherAccount.address
      );
      const sig = buildSchnorrSignature(aggSigner.privateKey, aggPk.x, aggPk.y, forgedHash);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, forgedHash, BITMAP_RELEASE))
        .to.be.revertedWithCustomError(vault, "InvalidMsgHash");
    });

    it("rejects domain tampering by chainId mismatch", async function () {
      const network = await ethers.provider.getNetwork();
      const forgedHash = await buildActionHashForDomain(
        "release",
        BITMAP_RELEASE,
        network.chainId + 1n,
        await vault.getAddress()
      );
      const sig = buildSchnorrSignature(aggSigner.privateKey, aggPk.x, aggPk.y, forgedHash);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, forgedHash, BITMAP_RELEASE))
        .to.be.revertedWithCustomError(vault, "InvalidMsgHash");
    });

    it("rejects wrong signer key", async function () {
      const wrongWallet = ethers.Wallet.createRandom();
      const sig = await signAction("release", BITMAP_RELEASE, wrongWallet);

      await expect(vault.release(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_RELEASE))
        .to.be.revertedWithCustomError(vault, "InvalidSignature");
    });
  });

  describe("Dispute and refund", function () {
    beforeEach(async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });
    });

    it("only buyer can open dispute", async function () {
      await expect(vault.connect(otherAccount).dispute())
        .to.be.revertedWithCustomError(vault, "NotBuyer");
    });

    it("opens dispute then refunds with valid bitmap", async function () {
      const escrowId = await vault.escrowId();
      await expect(vault.connect(buyer).dispute())
        .to.emit(vault, "DisputeOpened")
        .withArgs(escrowId);

      const sig = await signAction("refund", BITMAP_REFUND);
      await expect(vault.refund(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_REFUND))
        .to.emit(vault, "FundsReleased")
        .withArgs(escrowId, buyer.address, BigInt(BITMAP_REFUND), "refund");

      expect(await vault.status()).to.equal(3n);
    });

    it("rejects invalid signer bitmap in refund", async function () {
      await vault.connect(buyer).dispute();
      const invalidBitmap = 0x7c;
      const sig = await signAction("refund", invalidBitmap);

      await expect(vault.refund(sig.rAddr, sig.z, sig.e, sig.msgHash, invalidBitmap))
        .to.be.revertedWithCustomError(vault, "InvalidSignerBitmap");
    });
  });

  describe("Timeout release path", function () {
    beforeEach(async function () {
      await vault.connect(buyer).lockFunds({ value: AMOUNT });
    });

    it("rejects timeout release before deadline", async function () {
      const sig = await signAction("timeout", BITMAP_TIMEOUT);

      await expect(vault.timeoutRelease(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_TIMEOUT))
        .to.be.revertedWithCustomError(vault, "NotTimedOut");
    });

    it("releases seller after timeout with valid signature", async function () {
      await time.increase(TIMEOUT_DAYS * 24 * 60 * 60 + 1);
      const sig = await signAction("timeout", BITMAP_TIMEOUT);
      const escrowId = await vault.escrowId();

      await expect(vault.timeoutRelease(sig.rAddr, sig.z, sig.e, sig.msgHash, BITMAP_TIMEOUT))
        .to.emit(vault, "FundsReleased")
        .withArgs(escrowId, seller.address, BigInt(BITMAP_TIMEOUT), "timeout");

      expect(await vault.status()).to.equal(2n);
    });

    it("rejects invalid signer bitmap in timeout release", async function () {
      await time.increase(TIMEOUT_DAYS * 24 * 60 * 60 + 1);
      const invalidBitmap = 0x7c;
      const sig = await signAction("timeout", invalidBitmap);

      await expect(vault.timeoutRelease(sig.rAddr, sig.z, sig.e, sig.msgHash, invalidBitmap))
        .to.be.revertedWithCustomError(vault, "InvalidSignerBitmap");
    });
  });
});
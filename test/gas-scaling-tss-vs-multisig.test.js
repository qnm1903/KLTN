// test/gas-scaling-tss-vs-multisig.test.js
//
// Bảng A — Gas thật theo số bên n, tách 2 kịch bản (happy / dispute), TSS vs Đa chữ ký.
// Mục tiêu: chứng minh TSS giữ O(1) còn Đa chữ ký tăng O(t) khi quy mô hội đồng tăng.
//
//   Happy   = lockFunds → giải ngân (TSS: release 1 tx | MultiSig: t × signRelease)
//   Dispute = lockFunds → dispute → hoàn tiền (TSS: refund 1 tx | MultiSig: t × signRefund)
//
// Ngưỡng t = 2⌊(n-1)/3⌋+1 (đồng bộ với dải party-compute ở chương 5).
//
// Chạy:  npx hardhat test test/gas-scaling-tss-vs-multisig.test.js
// Kết quả: gas_scaling_results.json

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

const N            = Number(process.env.SCALE_N || 10);
const AMOUNT       = ethers.parseEther("1.0");
const CONFIRM_DAYS = 14;
const TIMEOUT_DAYS = 21;
const ORDER        = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const OUTPUT_FILE  = path.resolve(__dirname, "../gas_scaling_results.json");

// Dải n khảo sát (giới hạn bởi 60 account của hardhat network).
const N_VALUES = (process.env.SCALE_CONFIGS
  ? process.env.SCALE_CONFIGS.split(",").map(Number)
  : [5, 7, 11, 15, 21, 25, 31, 40, 55]);

const thresholdFor = (n) => 2 * Math.floor((n - 1) / 3) + 1;

// ─── Crypto helpers (trusted-dealer aggregate key, giống gas-benchmark) ──────

function toPublicXY(privateKey) {
  const pub = ethers.SigningKey.computePublicKey(privateKey, false);
  return { x: "0x" + pub.slice(4, 68), y: "0x" + pub.slice(68, 132) };
}

function randomAggKey() {
  const w = ethers.Wallet.createRandom();
  return { pk: w.privateKey, ...toPublicXY(w.privateKey) };
}

function buildSchnorrSignature(privateKey, pkX, pkY, msgHash) {
  const nonce    = ethers.hexlify(ethers.randomBytes(32));
  const noncePub = ethers.SigningKey.computePublicKey(nonce, false);
  const R_x      = "0x" + noncePub.slice(4, 68);
  const R_y      = "0x" + noncePub.slice(68, 132);
  const R_addr   = ethers.computeAddress("0x04" + R_x.slice(2) + R_y.slice(2));
  const e = ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256", "bytes32"], [R_addr, pkX, pkY, msgHash]
  );
  const z = (BigInt(nonce) + ((BigInt(e) * BigInt(privateKey)) % ORDER)) % ORDER;
  return { R_addr, z: ethers.toBeHex(z, 32), e };
}

async function buildMsgHash(vault, action, signerBitmap) {
  const chainId  = (await ethers.provider.getNetwork()).chainId;
  const escrowId = await vault.escrowId();
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "bytes32", "string", "uint256"],
    [chainId, await vault.getAddress(), escrowId, action, signerBitmap]
  );
}

// Bitmap với đúng t bit thấp nhất (gồm bit0=buyer, bit1=seller) → qua validateSignerBitmap.
const bitmapForT = (t) => (1n << BigInt(t)) - 1n;

function calcStats(samples) {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? samples.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const margin = 1.96 * (stdDev / Math.sqrt(n));
  return {
    mean: Math.round(mean),
    min: Math.min(...samples),
    max: Math.max(...samples),
    stdDev: parseFloat(stdDev.toFixed(2)),
    ci95: [Math.round(mean - margin), Math.round(mean + margin)],
  };
}

// ─── Deploy helpers ──────────────────────────────────────────────────────────

async function deployTssVault(buyer, seller, mediators, aggKey, threshold) {
  const Factory = await ethers.getContractFactory("EscrowFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const tx = await factory.connect(buyer).createEscrow(
    seller.address, mediators,
    [BigInt(aggKey.x), BigInt(aggKey.y)],
    AMOUNT, CONFIRM_DAYS, TIMEOUT_DAYS, BigInt(threshold)
  );
  const receipt = await tx.wait();
  const ev = receipt.logs.find((l) => l.fragment && l.fragment.name === "EscrowCreatedEvent");
  return ethers.getContractAt("EscrowVault", ev.args[0]);
}

async function deployMultiSig(buyer, seller, mediators, threshold) {
  const MS = await ethers.getContractFactory("MultiSigEscrow");
  const ms = await MS.deploy(
    ethers.randomBytes(32), buyer.address, seller.address, mediators,
    AMOUNT, CONFIRM_DAYS, TIMEOUT_DAYS, BigInt(threshold)
  );
  await ms.waitForDeployment();
  return ms;
}

const gasOf = async (txPromise) => Number((await (await txPromise).wait()).gasUsed);

// ─── Suite ───────────────────────────────────────────────────────────────────

describe(`Gas Scaling — TSS vs MultiSig theo n (N=${N})`, function () {
  this.timeout(3_600_000); // tới 60 phút cho n lớn

  let signers;
  before(async function () { signers = await ethers.getSigners(); });

  const results = [];

  for (const n of N_VALUES) {
    it(`n=${n} (t=${thresholdFor(n)})`, async function () {
      const t = thresholdFor(n);
      const buyer = signers[0], seller = signers[1];
      const mediators = signers.slice(2, n).map((s) => s.address);
      const signParties = signers.slice(0, t); // t bên ký đầu tiên (gồm buyer, seller)
      const bm = bitmapForT(t);

      const acc = { tssHappy: [], tssDispute: [], msHappy: [], msDispute: [] };

      for (let i = 0; i < N; i++) {
        // ── TSS happy: lock + release (verify 1 chữ ký tổng hợp → O(1)) ──
        {
          const key   = randomAggKey();
          const vault = await deployTssVault(buyer, seller, mediators, key, t);
          let g = await gasOf(vault.connect(buyer).lockFunds({ value: AMOUNT }));
          const mh  = await buildMsgHash(vault, "release", bm);
          const sig = buildSchnorrSignature(key.pk, key.x, key.y, mh);
          g += await gasOf(vault.release(sig.R_addr, sig.z, sig.e, mh, bm));
          acc.tssHappy.push(g);
        }
        // ── TSS dispute: lock + dispute + refund ──
        {
          const key   = randomAggKey();
          const vault = await deployTssVault(buyer, seller, mediators, key, t);
          let g = await gasOf(vault.connect(buyer).lockFunds({ value: AMOUNT }));
          g += await gasOf(vault.connect(buyer).dispute());
          const mh  = await buildMsgHash(vault, "refund", bm);
          const sig = buildSchnorrSignature(key.pk, key.x, key.y, mh);
          g += await gasOf(vault.refund(sig.R_addr, sig.z, sig.e, mh, bm));
          acc.tssDispute.push(g);
        }
        // ── MultiSig happy: lock + t × signRelease (O(t)) ──
        {
          const ms = await deployMultiSig(buyer, seller, mediators, t);
          let g = await gasOf(ms.connect(buyer).lockFunds({ value: AMOUNT }));
          for (let j = 0; j < t; j++) g += await gasOf(ms.connect(signParties[j]).signRelease());
          acc.msHappy.push(g);
        }
        // ── MultiSig dispute: lock + dispute + t × signRefund (O(t)) ──
        {
          const ms = await deployMultiSig(buyer, seller, mediators, t);
          let g = await gasOf(ms.connect(buyer).lockFunds({ value: AMOUNT }));
          g += await gasOf(ms.connect(buyer).dispute());
          for (let j = 0; j < t; j++) g += await gasOf(ms.connect(signParties[j]).signRefund());
          acc.msDispute.push(g);
        }
      }

      const row = {
        n, t,
        tss:      { happy: calcStats(acc.tssHappy), dispute: calcStats(acc.tssDispute) },
        multisig: { happy: calcStats(acc.msHappy),  dispute: calcStats(acc.msDispute) },
      };
      row.savings = {
        happy_pct:   parseFloat((((row.multisig.happy.mean   - row.tss.happy.mean)   / row.multisig.happy.mean)   * 100).toFixed(2)),
        dispute_pct: parseFloat((((row.multisig.dispute.mean - row.tss.dispute.mean) / row.multisig.dispute.mean) * 100).toFixed(2)),
      };
      results.push(row);

      console.log(`  n=${n} t=${t} | happy TSS=${row.tss.happy.mean} MS=${row.multisig.happy.mean} (-${row.savings.happy_pct}%)` +
                  ` | dispute TSS=${row.tss.dispute.mean} MS=${row.multisig.dispute.mean} (-${row.savings.dispute_pct}%)`);
    });
  }

  after(function () {
    const output = {
      metadata: {
        N, network: "hardhat", timestamp: new Date().toISOString(),
        threshold_rule: "t = 2*floor((n-1)/3)+1",
        note: "Gas tổng mỗi kịch bản (gồm lockFunds). receipt.gasUsed, Hardhat local.",
      },
      results,
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
    console.log(`\n📁 Đã lưu: ${OUTPUT_FILE}`);
  });
});

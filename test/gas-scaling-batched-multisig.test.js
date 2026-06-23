// test/gas-scaling-batched-multisig.test.js
//
// Bảng A (bổ sung) — Gas thật theo n cho đa chữ ký GỘP kiểu Gnosis Safe (1 tx, verify t
// ecrecover trong vòng lặp), tách 2 kịch bản happy / dispute. Dùng cùng dải n và ngưỡng
// t = 2⌊(n-1)/3⌋+1 để xếp cạnh TSS và đa chữ ký t-giao-dịch.
//
// Chủ sở hữu ký off-chain; một relayer (buyer, đã nạp ETH) gửi giao dịch gộp.
//
// Chạy:  npx hardhat test test/gas-scaling-batched-multisig.test.js
// Kết quả: gas_scaling_batched_results.json

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

const N      = Number(process.env.SCALE_N || 10);
const AMOUNT = ethers.parseEther("1.0");
const OUTPUT = path.resolve(__dirname, "../gas_scaling_batched_results.json");
const N_VALUES = (process.env.SCALE_CONFIGS ? process.env.SCALE_CONFIGS.split(",").map(Number)
                                            : [5, 7, 11, 15, 21, 25, 31, 40, 55]);
const thresholdFor = (n) => 2 * Math.floor((n - 1) / 3) + 1;

function calcStats(s) {
  const n = s.length, mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(n > 1 ? s.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0);
  const m = 1.96 * sd / Math.sqrt(n);
  return { mean: Math.round(mean), min: Math.min(...s), max: Math.max(...s), stdDev: +sd.toFixed(2), ci95: [Math.round(mean - m), Math.round(mean + m)] };
}
const gasOf = async (p) => Number((await (await p).wait()).gasUsed);

// t chữ ký 65-byte nối tiếp, sắp xếp địa chỉ tăng dần (yêu cầu của checkNSignatures).
function buildSignatures(ownerWallets, t, digest) {
  const sel = ownerWallets.slice(0, t)
    .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  let sigs = "0x";
  for (const w of sel) {
    const sg = w.signingKey.sign(digest);
    sigs += sg.r.slice(2) + sg.s.slice(2) + sg.v.toString(16).padStart(2, "0");
  }
  return sigs;
}

describe(`Gas Scaling — Đa chữ ký gộp (Gnosis Safe) theo n (N=${N})`, function () {
  this.timeout(3_600_000);
  let funder;
  before(async function () { [funder] = await ethers.getSigners(); });

  const results = [];

  for (const n of N_VALUES) {
    it(`n=${n} (t=${thresholdFor(n)})`, async function () {
      const t = thresholdFor(n);
      const F = await ethers.getContractFactory("BatchedMultiSigEscrow");
      const acc = { happy: [], dispute: [] };

      for (let i = 0; i < N; i++) {
        // Ví ngẫu nhiên: buyer (relayer, có ETH), seller, n-2 mediators (chỉ ký off-chain).
        const buyer  = ethers.Wallet.createRandom().connect(ethers.provider);
        const seller = ethers.Wallet.createRandom().connect(ethers.provider);
        const meds   = Array.from({ length: n - 2 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
        await (await funder.sendTransaction({ to: buyer.address, value: ethers.parseEther("3") })).wait();
        const owners = [buyer, seller, ...meds];
        const medAddrs = meds.map((m) => m.address);
        const chainId = (await ethers.provider.getNetwork()).chainId;

        const digestFor = (addr, eid, action) =>
          ethers.solidityPackedKeccak256(["uint256", "address", "bytes32", "string"], [chainId, addr, eid, action]);

        // ── happy: lock + release(gộp) ──
        {
          const eid = ethers.hexlify(ethers.randomBytes(32));
          const c = await F.connect(buyer).deploy(eid, buyer.address, seller.address, medAddrs, AMOUNT, BigInt(t));
          await c.waitForDeployment();
          const addr = await c.getAddress();
          let g = await gasOf(c.connect(buyer).lockFunds({ value: AMOUNT }));
          const sigs = buildSignatures(owners, t, digestFor(addr, eid, "release"));
          g += await gasOf(c.connect(buyer).release(sigs));
          acc.happy.push(g);
        }
        // ── dispute: lock + dispute + refund(gộp) ──
        {
          const eid = ethers.hexlify(ethers.randomBytes(32));
          const c = await F.connect(buyer).deploy(eid, buyer.address, seller.address, medAddrs, AMOUNT, BigInt(t));
          await c.waitForDeployment();
          const addr = await c.getAddress();
          let g = await gasOf(c.connect(buyer).lockFunds({ value: AMOUNT }));
          g += await gasOf(c.connect(buyer).dispute());
          const sigs = buildSignatures(owners, t, digestFor(addr, eid, "refund"));
          g += await gasOf(c.connect(buyer).refund(sigs));
          acc.dispute.push(g);
        }
      }

      const row = { n, t, happy: calcStats(acc.happy), dispute: calcStats(acc.dispute) };
      results.push(row);
      console.log(`  n=${n} t=${t} | gộp happy=${row.happy.mean} dispute=${row.dispute.mean}`);
    });
  }

  after(function () {
    fs.writeFileSync(OUTPUT, JSON.stringify({
      metadata: { N, network: "hardhat", model: "batched/Gnosis-Safe-style (1 tx, t ecrecover)",
        threshold_rule: "t = 2*floor((n-1)/3)+1", timestamp: new Date().toISOString() },
      results,
    }, null, 2), "utf8");
    console.log(`\n📁 Đã lưu: ${OUTPUT}`);
  });
});

// test/gas-multischeme-onchain.test.js
//
// Bảng B (on-chain) — Chi phí gas giải ngân thật của verify từng lược đồ chữ ký trên EVM.
// Đo lock + release đầu-cuối cho 3 lược đồ tổng-hợp-một-chữ-ký (O(1) verify):
//   - Schnorr-TSS  : EscrowVault (ecrecover trick, secp256k1)        [của đề tài]
//   - ECDSA-TSS    : EcdsaEscrow (1 ecrecover, proxy chi phí on-chain)
//   - BLS          : BlsEscrow   (MAP_FP_TO_G1 + PAIRING_CHECK, EIP-2537)
// Đa chữ ký (O(t)) đo riêng ở gas-scaling-tss-vs-multisig.test.js.
//
// Chạy:  npx hardhat test test/gas-multischeme-onchain.test.js
// Kết quả: gas_multischeme_onchain_results.json

const { ethers } = require("hardhat");
const { bls12_381 } = require("@noble/curves/bls12-381");
const fs   = require("fs");
const path = require("path");

const N            = Number(process.env.MS_N || 20);
const AMOUNT       = ethers.parseEther("1.0");
const CONFIRM_DAYS = 14, TIMEOUT_DAYS = 21;
const ORDER  = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const OUTPUT = path.resolve(__dirname, "../gas_multischeme_onchain_results.json");

// ─── BLS helpers (khớp BlsEscrow + precompile, đã kiểm trong bls-roundtrip-spike) ──
const FP  = bls12_381.fields.Fp.ORDER;
const R   = bls12_381.params.r;
const G1  = bls12_381.G1.ProjectivePoint;
const G2  = bls12_381.G2.ProjectivePoint;
const MAP = "0x0000000000000000000000000000000000000010";
const encFp  = (x) => "00".repeat(16) + x.toString(16).padStart(96, "0");
const decFp  = (hex, off) => BigInt("0x" + hex.slice(off + 32, off + 128));
const encG1  = (pt) => { const a = pt.toAffine(); return encFp(a.x) + encFp(a.y); };
const encG2  = (pt) => { const a = pt.toAffine(); return encFp(a.x.c0) + encFp(a.x.c1) + encFp(a.y.c0) + encFp(a.y.c1); };

// ─── Schnorr helpers (khớp EscrowVault) ───────────────────────────────────────
function toPublicXY(pk) { const p = ethers.SigningKey.computePublicKey(pk, false); return { x: "0x" + p.slice(4, 68), y: "0x" + p.slice(68, 132) }; }
function buildSchnorr(pk, pkX, pkY, msgHash) {
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const np = ethers.SigningKey.computePublicKey(nonce, false);
  const R_addr = ethers.computeAddress("0x04" + np.slice(4, 68).slice(0) /*x*/ + np.slice(68, 132));
  const e = ethers.solidityPackedKeccak256(["address", "uint256", "uint256", "bytes32"], [R_addr, pkX, pkY, msgHash]);
  const z = (BigInt(nonce) + ((BigInt(e) * BigInt(pk)) % ORDER)) % ORDER;
  return { R_addr, z: ethers.toBeHex(z, 32), e };
}

function calcStats(s) {
  const n = s.length, mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(n > 1 ? s.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0);
  const m = 1.96 * sd / Math.sqrt(n);
  return { mean: Math.round(mean), min: Math.min(...s), max: Math.max(...s), stdDev: +sd.toFixed(2), ci95: [Math.round(mean - m), Math.round(mean + m)] };
}
const gasOf = async (p) => Number((await (await p).wait()).gasUsed);

describe(`Gas Bảng B on-chain — Schnorr vs ECDSA vs BLS (N=${N})`, function () {
  this.timeout(1_200_000);
  let buyer, seller, mediators;
  const acc = { schnorr: [], ecdsa: [], bls: [] };

  before(async function () {
    const s = await ethers.getSigners();
    buyer = s[0]; seller = s[1];
    mediators = s.slice(2, 7).map((x) => x.address); // 5-of-7 config
  });

  it(`Schnorr-TSS (EscrowVault) ×${N}`, async function () {
    const Factory = await ethers.getContractFactory("EscrowFactory");
    for (let i = 0; i < N; i++) {
      const w = ethers.Wallet.createRandom(); const key = { pk: w.privateKey, ...toPublicXY(w.privateKey) };
      const factory = await Factory.deploy(); await factory.waitForDeployment();
      const tx = await factory.connect(buyer).createEscrow(seller.address, mediators, [BigInt(key.x), BigInt(key.y)], AMOUNT, CONFIRM_DAYS, TIMEOUT_DAYS, 5n);
      const rc = await tx.wait();
      const addr = rc.logs.find((l) => l.fragment && l.fragment.name === "EscrowCreatedEvent").args[0];
      const vault = await ethers.getContractAt("EscrowVault", addr);
      let g = await gasOf(vault.connect(buyer).lockFunds({ value: AMOUNT }));
      const bm = 0x1fn;
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const eid = await vault.escrowId();
      const mh = ethers.solidityPackedKeccak256(["uint256", "address", "bytes32", "string", "uint256"], [chainId, addr, eid, "release", bm]);
      const sig = buildSchnorr(key.pk, key.x, key.y, mh);
      g += await gasOf(vault.release(sig.R_addr, sig.z, sig.e, mh, bm));
      acc.schnorr.push(g);
    }
    console.log("  Schnorr settlement gas:", calcStats(acc.schnorr).mean);
  });

  it(`ECDSA-TSS (EcdsaEscrow) ×${N}`, async function () {
    const F = await ethers.getContractFactory("EcdsaEscrow");
    for (let i = 0; i < N; i++) {
      const w = ethers.Wallet.createRandom();
      const eid = ethers.hexlify(ethers.randomBytes(32));
      const c = await F.deploy(eid, buyer.address, seller.address, AMOUNT, w.address); await c.waitForDeployment();
      const addr = await c.getAddress();
      let g = await gasOf(c.connect(buyer).lockFunds({ value: AMOUNT }));
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const mh = ethers.solidityPackedKeccak256(["uint256", "address", "bytes32", "string"], [chainId, addr, eid, "release"]);
      const sg = new ethers.SigningKey(w.privateKey).sign(mh);
      g += await gasOf(c.release(sg.v, sg.r, sg.s));
      acc.ecdsa.push(g);
    }
    console.log("  ECDSA settlement gas:", calcStats(acc.ecdsa).mean);
  });

  it(`BLS (BlsEscrow, EIP-2537) ×${N}`, async function () {
    const F = await ethers.getContractFactory("BlsEscrow");
    const signer = buyer;
    for (let i = 0; i < N; i++) {
      const sk = (BigInt(ethers.hexlify(ethers.randomBytes(32))) % (R - 1n)) + 1n;
      const pk = "0x" + encG2(G2.BASE.multiply(sk));
      const eid = ethers.hexlify(ethers.randomBytes(32));
      const c = await F.deploy(eid, buyer.address, seller.address, AMOUNT, pk); await c.waitForDeployment();
      const addr = await c.getAddress();
      let g = await gasOf(c.connect(buyer).lockFunds({ value: AMOUNT }));
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const mh = ethers.solidityPackedKeccak256(["uint256", "address", "bytes32", "string"], [chainId, addr, eid, "release"]);
      const u = BigInt(mh) % FP;
      const hmOut = await signer.call({ to: MAP, data: "0x" + encFp(u) });
      const Hm = G1.fromAffine({ x: decFp(hmOut.slice(2), 0), y: decFp(hmOut.slice(2), 128) });
      const sig = "0x" + encG1(Hm.multiply(sk));
      g += await gasOf(c.release(sig));
      acc.bls.push(g);
    }
    console.log("  BLS settlement gas:", calcStats(acc.bls).mean);
  });

  after(function () {
    const out = {
      metadata: { N, network: "hardhat", timestamp: new Date().toISOString(), config: "5-of-7 (Schnorr); single-aggregate (ECDSA/BLS)",
        note: "lock+release end-to-end gas. BLS H(m) dùng MAP_FP_TO_G1 đơn ánh (không phải hash_to_curve 2-map đầy đủ)." },
      schnorr_tss: calcStats(acc.schnorr),
      ecdsa_tss:   calcStats(acc.ecdsa),
      bls:         calcStats(acc.bls),
    };
    fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2), "utf8");
    console.log(`\n📁 Đã lưu: ${OUTPUT}`);
  });
});

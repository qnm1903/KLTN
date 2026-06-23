// Spike: BLS verify round-trip consistent with EIP-2537 precompiles.
// Strategy: derive the message point Hm via the on-chain MAP_FP_TO_G1 precompile (0x10),
// then scalar-multiply with noble to build sig = sk*Hm and pk = sk*G2. This guarantees the
// off-chain signature matches exactly what a Solidity verifier would compute.
// Verify equation: e(sig, -G2) * e(Hm, pk) == 1  →  PAIRING_CHECK (0x0f) returns 1.

const { ethers } = require("hardhat");
const { bls12_381 } = require("@noble/curves/bls12-381");

const MAP_FP_TO_G1 = "0x0000000000000000000000000000000000000010";
const PAIRING_CHECK = "0x000000000000000000000000000000000000000f";
const P  = bls12_381.fields.Fp.ORDER;
const R  = bls12_381.params.r;
const G1 = bls12_381.G1.ProjectivePoint;
const G2 = bls12_381.G2.ProjectivePoint;

const fp = (x) => x.toString(16).padStart(96, "0");           // 48-byte BE
const enc = (x) => "00".repeat(16) + fp(x);                   // 64-byte padded Fp
const dec = (hex, off) => BigInt("0x" + hex.slice(off + 32, off + 128)); // skip 16-byte pad

function encG1(pt) { const a = pt.toAffine(); return enc(a.x) + enc(a.y); }
function encG2(pt, order) {
  const a = pt.toAffine();
  // EIP-2537 Fp2 serialization order probed below.
  return order === "c0c1"
    ? enc(a.x.c0) + enc(a.x.c1) + enc(a.y.c0) + enc(a.y.c1)
    : enc(a.x.c1) + enc(a.x.c0) + enc(a.y.c1) + enc(a.y.c0);
}

describe("EIP-2537 BLS verify round-trip", function () {
  it("e(sig,-G2)*e(Hm,pk) == 1 via precompiles", async function () {
    const [signer] = await ethers.getSigners();

    // 1) message → fp → G1 via precompile
    const msgHash = ethers.hexlify(ethers.randomBytes(32));
    const u = BigInt(msgHash) % P;
    const hmOut = await signer.call({ to: MAP_FP_TO_G1, data: "0x" + enc(u) });
    const hmHex = hmOut.slice(2);
    const Hm = G1.fromAffine({ x: dec(hmHex, 0), y: dec(hmHex, 128) });
    console.log("  MAP output parsed, on curve:", (() => { try { Hm.assertValidity(); return true; } catch { return false; } })());

    // 2) keys + signature off-chain
    const sk  = (BigInt(ethers.hexlify(ethers.randomBytes(32))) % (R - 1n)) + 1n;
    const sig = Hm.multiply(sk);
    const pk  = G2.BASE.multiply(sk);
    const negG2 = G2.BASE.negate();

    // 3) pairing check, probing Fp2 byte order
    for (const order of ["c0c1", "c1c0"]) {
      const input = "0x" + encG1(sig) + encG2(negG2, order) + encG1(Hm) + encG2(pk, order);
      try {
        const out = await signer.call({ to: PAIRING_CHECK, data: input });
        const ok = BigInt(out) === 1n;
        console.log(`  Fp2 order ${order}: pairing returned ${out} → ${ok ? "VALID ✅" : "invalid"}`);
        if (ok) return;
      } catch (e) {
        console.log(`  Fp2 order ${order}: reverted (${(e.shortMessage || e.message).slice(0, 60)})`);
      }
    }
    throw new Error("Neither Fp2 byte order produced a valid pairing");
  });
});

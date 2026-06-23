// Spike: detect EIP-2537 BLS12-381 precompiles on the Hardhat (prague) EVM.
// Detection logic:
//   - A real precompile reverts on malformed input (wrong length).
//   - A non-existent precompile address behaves like an empty account:
//     the call succeeds and returns empty data.
// We also try a valid G1ADD (P + identity = P) using a noble-generated point
// to confirm correct output, not just presence.

const { ethers } = require("hardhat");
const { bls12_381 } = require("@noble/curves/bls12-381");

const G1ADD = "0x000000000000000000000000000000000000000b";

// EIP-2537 field element encoding: 64 bytes (16 zero pad + 48-byte big-endian Fp).
function encodeFp(xBigInt) {
  const hex = xBigInt.toString(16).padStart(96, "0"); // 48 bytes
  return "00".repeat(16) + hex;
}

function encodeG1(point) {
  const aff = point.toAffine();
  return "0x" + encodeFp(aff.x) + encodeFp(aff.y);
}

describe("EIP-2537 BLS precompile spike", function () {
  it("detects whether G1ADD precompile exists", async function () {
    const [signer] = await ethers.getSigners();

    // 1) Presence probe: malformed (empty) input.
    let presence;
    try {
      const ret = await signer.call({ to: G1ADD, data: "0x" });
      presence = ret === "0x"
        ? "ABSENT (call ok, empty data — behaves like empty account)"
        : `AMBIGUOUS (ok, data=${ret})`;
    } catch (e) {
      presence = "PRESENT (reverted on malformed input as a real precompile would)";
    }
    console.log("  Presence probe:", presence);

    // 2) Functional probe: P + O = P where O is the identity (all-zero 256 bytes).
    const G = bls12_381.G1.ProjectivePoint.BASE;
    const pEnc = encodeG1(G).slice(2);
    const identity = "00".repeat(128);
    const input = "0x" + pEnc + identity;

    let functional;
    try {
      const out = await signer.call({ to: G1ADD, data: input });
      functional = out.toLowerCase() === ("0x" + pEnc).toLowerCase()
        ? "WORKS (P + O == P, output matches)"
        : `UNEXPECTED OUTPUT (len=${(out.length - 2) / 2} bytes): ${out.slice(0, 66)}...`;
    } catch (e) {
      functional = "FAILED: " + (e.shortMessage || e.message);
    }
    console.log("  Functional probe:", functional);
  });
});

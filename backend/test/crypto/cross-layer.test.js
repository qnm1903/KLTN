import { initDKG, getPkAggForRoles } from '../../src/crypto/dkg.js';
import {
  aggregateNonces,
  computeChallenge,
  computeSignatureShare,
  aggregateZShares,
  verifySchnorr
} from '../../src/crypto/schnorr.js';
import { generateKeyPair } from '../../src/crypto/ecc.js';
import { ethers } from 'ethers';

describe('Cross-layer: Schnorr signing flow', () => {
  let escrowId;
  let session;
  let keys;

  beforeAll(() => {
    escrowId = '0x' + '1a2b3c'.padEnd(64, '0');

    keys = {
      buyer: generateKeyPair(),
      seller: generateKeyPair(),
      mediator: generateKeyPair()
    };

    const { session: dkgSession } = initDKG(escrowId, {
      buyerPubKey: keys.buyer.pubKey,
      sellerPubKey: keys.seller.pubKey,
      mediatorPubKey: keys.mediator.pubKey
    });
    session = dkgSession;
  });

  function signForPair(action, roleA, roleB) {
    const msgHash = ethers.solidityPackedKeccak256(['bytes32', 'string'], [escrowId, action]);
    const pkAgg = getPkAggForRoles(session, [roleA, roleB]);

    const nonceA = ethers.hexlify(ethers.randomBytes(32));
    const nonceB = ethers.hexlify(ethers.randomBytes(32));
    const zeroChallenge = '0x' + '00'.repeat(32);

    const round1A = computeSignatureShare(keys[roleA].privKey, nonceA, zeroChallenge);
    const round1B = computeSignatureShare(keys[roleB].privKey, nonceB, zeroChallenge);

    const { R_addr } = aggregateNonces([
      { R_x: round1A.R_x, R_y: round1A.R_y },
      { R_x: round1B.R_x, R_y: round1B.R_y }
    ]);

    const e = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);
    const shareA = computeSignatureShare(keys[roleA].privKey, nonceA, e);
    const shareB = computeSignatureShare(keys[roleB].privKey, nonceB, e);
    const z = aggregateZShares([shareA.z, shareB.z]);

    return { pkAgg, msgHash, R_addr, z, e };
  }

  it('buyer + seller should produce a valid release signature', () => {
    const sig = signForPair('release', 'buyer', 'seller');
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, sig.e)).toBe(true);
  });

  it('buyer + mediator should produce a valid refund signature', () => {
    const sig = signForPair('refund', 'buyer', 'mediator');
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, sig.e)).toBe(true);
  });

  it('seller + mediator should produce a valid timeout signature', () => {
    const sig = signForPair('timeout', 'seller', 'mediator');
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, sig.e)).toBe(true);
  });

  it('tampering challenge should invalidate signature', () => {
    const sig = signForPair('release', 'buyer', 'seller');
    const badE = ethers.solidityPackedKeccak256(['bytes32'], [sig.e]);
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, badE)).toBe(false);
  });
});

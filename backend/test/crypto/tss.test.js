import {
  aggregatePublicKeys,
  aggregateNonces,
  computeChallenge,
  computeSignatureShare,
  aggregateZShares,
  verifySchnorr
} from '../../src/crypto/schnorr.js';
import { generateKeyPair } from '../../src/crypto/ecc.js';
import { ethers } from 'ethers';

describe('Schnorr Crypto Functions', () => {
  let buyer;
  let seller;
  let pkAgg;

  beforeAll(() => {
    buyer = generateKeyPair();
    seller = generateKeyPair();
    pkAgg = aggregatePublicKeys([buyer.pubKey, seller.pubKey]);
  });

  it('should aggregate public keys and nonces correctly', () => {
    const nonceA = ethers.hexlify(ethers.randomBytes(32));
    const nonceB = ethers.hexlify(ethers.randomBytes(32));
    const zero = '0x' + '00'.repeat(32);

    const a = computeSignatureShare(buyer.privKey, nonceA, zero);
    const b = computeSignatureShare(seller.privKey, nonceB, zero);

    const agg = aggregateNonces([
      { R_x: a.R_x, R_y: a.R_y },
      { R_x: b.R_x, R_y: b.R_y }
    ]);

    expect(agg.R_x.startsWith('0x')).toBe(true);
    expect(agg.R_y.startsWith('0x')).toBe(true);
    expect(agg.R_addr.startsWith('0x')).toBe(true);
  });

  it('should produce verifiable Schnorr signature from two signature shares', () => {
    const msgHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'string'],
      ['0x' + 'ab'.repeat(32), 'release']
    );

    const nonceA = ethers.hexlify(ethers.randomBytes(32));
    const nonceB = ethers.hexlify(ethers.randomBytes(32));
    const zero = '0x' + '00'.repeat(32);

    const round1A = computeSignatureShare(buyer.privKey, nonceA, zero);
    const round1B = computeSignatureShare(seller.privKey, nonceB, zero);

    const { R_addr } = aggregateNonces([
      { R_x: round1A.R_x, R_y: round1A.R_y },
      { R_x: round1B.R_x, R_y: round1B.R_y }
    ]);

    const e = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);
    const shareA = computeSignatureShare(buyer.privKey, nonceA, e);
    const shareB = computeSignatureShare(seller.privKey, nonceB, e);
    const z = aggregateZShares([shareA.z, shareB.z]);

    expect(verifySchnorr(pkAgg, msgHash, R_addr, z, e)).toBe(true);
  });
});
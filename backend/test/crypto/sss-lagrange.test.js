import { aggregateNoncesWithLagrange, aggregatePubKeysWithLagrange, aggregateZSharesWithLagrange, computeChallenge, computeSignatureShare, verifySchnorr } from '../../src/crypto/schnorr.js';
import { ROLE_TO_ID } from '../../src/crypto/dkg.js';
import { generateKeyPair } from '../../src/crypto/ecc.js';
import { ethers } from 'ethers';

test('SSS Lagrange aggregation runs without runtime errors (3 parties)', () => {
  const roles = ['buyer', 'seller', 'mediator1'];

  // Generate keypairs
  const kp = roles.map(() => generateKeyPair());
  const pubKeys = {};
  const privs = {};
  for (let i = 0; i < roles.length; i++) {
    pubKeys[roles[i]] = kp[i].pubKey;
    privs[roles[i]] = kp[i].privKey;
  }

  // Generate nonces
  const nonceA = ethers.hexlify(ethers.randomBytes(32));
  const nonceB = ethers.hexlify(ethers.randomBytes(32));
  const nonceC = ethers.hexlify(ethers.randomBytes(32));

  const rA = computeSignatureShare(privs[roles[0]], nonceA, '0x' + '00'.repeat(32));
  const rB = computeSignatureShare(privs[roles[1]], nonceB, '0x' + '00'.repeat(32));
  const rC = computeSignatureShare(privs[roles[2]], nonceC, '0x' + '00'.repeat(32));

  const aggR = aggregateNoncesWithLagrange({
    [roles[0]]: { R_x: rA.R_x, R_y: rA.R_y },
    [roles[1]]: { R_x: rB.R_x, R_y: rB.R_y },
    [roles[2]]: { R_x: rC.R_x, R_y: rC.R_y }
  }, ROLE_TO_ID);

  const msgHash = ethers.solidityPackedKeccak256(['bytes32', 'string'], ['0x' + 'aa'.repeat(32), 'release']);
  const pkAgg = aggregatePubKeysWithLagrange(pubKeys, roles, ROLE_TO_ID);
  const challenge = computeChallenge(aggR.R_addr, pkAgg.x, pkAgg.y, msgHash);

  // Compute signature shares using challenge
  const shareA = computeSignatureShare(privs[roles[0]], nonceA, challenge);
  const shareB = computeSignatureShare(privs[roles[1]], nonceB, challenge);
  const shareC = computeSignatureShare(privs[roles[2]], nonceC, challenge);

  const zShares = {
    [roles[0]]: shareA.z,
    [roles[1]]: shareB.z,
    [roles[2]]: shareC.z
  };

  const zAgg = aggregateZSharesWithLagrange(zShares, ROLE_TO_ID);

  expect(typeof pkAgg.x).toBe('string');
  expect(typeof pkAgg.y).toBe('string');
  expect(typeof zAgg).toBe('string');
  expect(zAgg.startsWith('0x')).toBe(true);
  expect(verifySchnorr(pkAgg, msgHash, aggR.R_addr, zAgg, challenge)).toBe(true);
});

import { deriveSignerBitmap, getActionSigners, getPkAggForRoles, initDKG } from '../../src/crypto/dkg.js';
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
    const contractAddress = '0x00000000000000000000000000000000000000aa';
    const chainId = 31337;

    keys = {
      buyer: generateKeyPair(),
      seller: generateKeyPair(),
      mediator1: generateKeyPair(),
      mediator2: generateKeyPair(),
      mediator3: generateKeyPair(),
      mediator4: generateKeyPair(),
      mediator5: generateKeyPair()
    };

    const { session: dkgSession } = initDKG(escrowId, {
      buyerPubKey: keys.buyer.pubKey,
      sellerPubKey: keys.seller.pubKey,
      mediatorPubKeys: [
        keys.mediator1.pubKey,
        keys.mediator2.pubKey,
        keys.mediator3.pubKey,
        keys.mediator4.pubKey,
        keys.mediator5.pubKey
      ],
      participants: {
        buyer: '0xbuyer',
        seller: '0xseller',
        mediators: ['0xm1', '0xm2', '0xm3', '0xm4', '0xm5']
      },
      contractAddress,
      chainId
    });
    session = dkgSession;
  });

  function signForAction(action) {
    const roles = getActionSigners(action);
    const signerBitmap = deriveSignerBitmap(roles);
    const msgHash = ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'bytes32', 'string', 'uint8'],
      [BigInt(session.chainId), session.contractAddress, escrowId, action, signerBitmap]
    );
    const pkAgg = getPkAggForRoles(session, roles);

    const zeroChallenge = '0x' + '00'.repeat(32);

    const round1Shares = roles.map((role) => {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const share = computeSignatureShare(keys[role].privKey, nonce, zeroChallenge);
      return { role, nonce, share };
    });

    const { R_addr } = aggregateNonces(
      round1Shares.map((row) => ({ R_x: row.share.R_x, R_y: row.share.R_y }))
    );

    const e = computeChallenge(R_addr, pkAgg.x, pkAgg.y, msgHash);
    const z = aggregateZShares(
      round1Shares.map((row) => computeSignatureShare(keys[row.role].privKey, row.nonce, e).z)
    );

    return { pkAgg, msgHash, R_addr, z, e };
  }

  it('release action signer set should produce a valid signature', () => {
    const sig = signForAction('release');
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, sig.e)).toBe(true);
  });

  it('refund action signer set should produce a valid signature', () => {
    const sig = signForAction('refund');
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, sig.e)).toBe(true);
  });

  it('timeout action signer set should produce a valid signature', () => {
    const sig = signForAction('timeout');
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, sig.e)).toBe(true);
  });

  it('tampering challenge should invalidate signature', () => {
    const sig = signForAction('release');
    const badE = ethers.solidityPackedKeccak256(['bytes32'], [sig.e]);
    expect(verifySchnorr(sig.pkAgg, sig.msgHash, sig.R_addr, sig.z, badE)).toBe(false);
  });
});

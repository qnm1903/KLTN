import { getActionSigners, getPkAggForRoles, initDKG } from '../../src/crypto/dkg.js';
import { generateKeyPair } from '../../src/crypto/ecc.js';

describe('DKG Crypto Functions', () => {
  it('should initialize pubkey-based DKG for 7 participants and derive aggregate keys by action signer set', () => {
    const escrowId = 'test-escrow-123';

    const buyer = generateKeyPair();
    const seller = generateKeyPair();
    const mediators = [
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair()
    ];

    const result = initDKG(escrowId, {
      buyerPubKey: buyer.pubKey,
      sellerPubKey: seller.pubKey,
      mediatorPubKeys: mediators.map((row) => row.pubKey),
      participants: {
        buyer: '0xbuyer',
        seller: '0xseller',
        mediators: ['0xm1', '0xm2', '0xm3', '0xm4', '0xm5']
      },
      contractAddress: '0x00000000000000000000000000000000000000aa',
      chainId: '31337'
    });

    expect(result).toHaveProperty('session');

    const sessionData = result.session;
    expect(sessionData).toBeDefined();
    expect(sessionData.status).toBe('INITIALIZED');
    expect(sessionData.pubKeys.buyer).toBe(buyer.pubKey);
    expect(sessionData.pubKeys.seller).toBe(seller.pubKey);
    expect(sessionData.pubKeys.mediator1).toBe(mediators[0].pubKey);
    expect(sessionData.pubKeys.mediator5).toBe(mediators[4].pubKey);

    const releasePk = getPkAggForRoles(sessionData, getActionSigners('release'));
    const refundPk = getPkAggForRoles(sessionData, getActionSigners('refund'));
    const timeoutPk = getPkAggForRoles(sessionData, getActionSigners('timeout'));

    expect(releasePk.x.startsWith('0x')).toBe(true);
    expect(refundPk.x.startsWith('0x')).toBe(true);
    expect(timeoutPk.x.startsWith('0x')).toBe(true);
    expect(releasePk.y.startsWith('0x')).toBe(true);
  });
});
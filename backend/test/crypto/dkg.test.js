import {
  aggregateWhenReady,
  getActionSigners,
  getPkAggForRoles,
  getPubKeyCollectionSummary,
  initDKG,
  initIncrementalDKG
} from '../../src/crypto/dkg.js';
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

  it('initializes incremental DKG session with pending collection state', () => {
    const now = Date.now();
    const { session } = initIncrementalDKG('escrow-incremental-1', {
      participants: {
        buyer: '0x1111111111111111111111111111111111111111',
        seller: '0x2222222222222222222222222222222222222222',
        mediators: [
          '0x3333333333333333333333333333333333333331',
          '0x3333333333333333333333333333333333333332',
          '0x3333333333333333333333333333333333333333',
          '0x3333333333333333333333333333333333333334',
          '0x3333333333333333333333333333333333333335'
        ]
      },
      contractAddress: '0x00000000000000000000000000000000000000aa',
      chainId: '31337',
      dueAtMs: now + 30 * 60 * 1000
    });

    const summary = getPubKeyCollectionSummary(session, now);
    expect(summary.state).toBe('PENDING');
    expect(summary.required).toBe(7);
    expect(summary.received).toBe(0);
    expect(summary.complete).toBe(false);
    expect(session.pubKeyAggregationCompletedAt).toBeNull();
  });

  it('aggregates only when all 7 pubkeys are collected', () => {
    const buyer = generateKeyPair();
    const seller = generateKeyPair();
    const mediators = [
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair()
    ];

    const { session } = initIncrementalDKG('escrow-incremental-2', {
      participants: {
        buyer: '0x1111111111111111111111111111111111111111',
        seller: '0x2222222222222222222222222222222222222222',
        mediators: [
          '0x3333333333333333333333333333333333333331',
          '0x3333333333333333333333333333333333333332',
          '0x3333333333333333333333333333333333333333',
          '0x3333333333333333333333333333333333333334',
          '0x3333333333333333333333333333333333333335'
        ]
      },
      contractAddress: '0x00000000000000000000000000000000000000aa',
      chainId: '31337'
    });

    session.pubKeys.buyer = buyer.pubKey;
    session.pubKeys.seller = seller.pubKey;
    session.pubKeys.mediator1 = mediators[0].pubKey;
    session.pubKeys.mediator2 = mediators[1].pubKey;
    session.pubKeys.mediator3 = mediators[2].pubKey;
    session.pubKeys.mediator4 = mediators[3].pubKey;

    expect(aggregateWhenReady(session)).toBeNull();

    session.pubKeys.mediator5 = mediators[4].pubKey;
    const aggregates = aggregateWhenReady(session);

    expect(aggregates).toBeDefined();
    expect(aggregates).toHaveProperty('release');
    expect(aggregates).toHaveProperty('refund');
    expect(aggregates).toHaveProperty('timeout');
    expect(aggregates.release.x.startsWith('0x')).toBe(true);
    expect(aggregates.release.y.startsWith('0x')).toBe(true);
  });
});
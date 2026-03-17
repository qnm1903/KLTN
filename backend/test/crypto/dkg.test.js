import { initDKG, getPkAggForRoles } from '../../src/crypto/dkg.js';
import { generateKeyPair } from '../../src/crypto/ecc.js';

describe('DKG Crypto Functions', () => {
  it('should initialize pubkey-based DKG and store three PKagg pairs', () => {
    // Mock a session store
    class MockSessionStore {
      constructor() {
        this.store = new Map();
      }
      set(key, value) {
        this.store.set(key, value);
      }
      get(key) {
        return this.store.get(key);
      }
    }

    const sessionStore = new MockSessionStore();
    const escrowId = 'test-escrow-123';

    const buyer = generateKeyPair();
    const seller = generateKeyPair();
    const mediator = generateKeyPair();

    const result = initDKG(
      escrowId,
      {
        buyerPubKey: buyer.pubKey,
        sellerPubKey: seller.pubKey,
        mediatorPubKey: mediator.pubKey
      },
      sessionStore
    );

    expect(result).toHaveProperty('pkAgg_bs');
    expect(result).toHaveProperty('pkAgg_bm');
    expect(result).toHaveProperty('pkAgg_sm');
    expect(result.pkAgg_bs.x.startsWith('0x')).toBe(true);
    expect(result.pkAgg_bs.y.startsWith('0x')).toBe(true);

    const sessionData = sessionStore.get(escrowId);
    expect(sessionData).toBeDefined();
    expect(sessionData.status).toBe('INITIALIZED');
    expect(sessionData.pubKeys.buyer).toBe(buyer.pubKey);
    expect(sessionData.pubKeys.seller).toBe(seller.pubKey);
    expect(sessionData.pubKeys.mediator).toBe(mediator.pubKey);

    const bs = getPkAggForRoles(sessionData, ['buyer', 'seller']);
    const bm = getPkAggForRoles(sessionData, ['buyer', 'mediator']);
    const sm = getPkAggForRoles(sessionData, ['seller', 'mediator']);

    expect(bs.x).toBe(result.pkAgg_bs.x);
    expect(bm.x).toBe(result.pkAgg_bm.x);
    expect(sm.x).toBe(result.pkAgg_sm.x);
  });
});
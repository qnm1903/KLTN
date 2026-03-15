import { initDKG } from '../../src/crypto/dkg.js';
import Secrets from 'secrets.js-grempe';
import { getPublicKey } from '../../src/crypto/ecc.js';

describe('DKG Crypto Functions', () => {
  it('should perform DKG, share keys and store correctly', async () => {
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

    const result = await initDKG(escrowId, sessionStore);

    // Verify it returned shares and address
    expect(result).toHaveProperty('pkAggAddress');
    expect(result).toHaveProperty('buyerShare');
    expect(result).toHaveProperty('sellerShare');
    expect(result).toHaveProperty('mediatorShare');

    // Verify properties
    expect(result.pkAggAddress.startsWith('0x')).toBe(true);
    expect(result.pkAggAddress.length).toBe(42);
    expect(typeof result.buyerShare).toBe('string');
    expect(typeof result.sellerShare).toBe('string');
    expect(typeof result.mediatorShare).toBe('string');

    // Verify the session store was updated correctly
    const sessionData = sessionStore.get(escrowId);
    expect(sessionData).toBeDefined();
    expect(sessionData.pkAggAddress).toBe(result.pkAggAddress);
    expect(sessionData.status).toBe('INITIALIZED');
    expect(sessionData.shares.buyer.share).toBe(result.buyerShare);
    expect(sessionData.shares.seller.share).toBe(result.sellerShare);
    expect(sessionData.shares.mediator.share).toBe(result.mediatorShare);

    // Verify Shamir Reconstruction works with any 2 shares (Threshold = 2)
    // 1. Reconstruct using buyer + seller (index 1 & 2)
    const combinedKey1 = Secrets.combine([sessionData.shares.buyer.share, sessionData.shares.seller.share]);
    // 2. Reconstruct using buyer + mediator (index 1 & 3)
    const combinedKey2 = Secrets.combine([sessionData.shares.buyer.share, sessionData.shares.mediator.share]);

    // They should yield the exact same combined private key hex
    expect(combinedKey1).toBe(combinedKey2);

    // And the derived aggregated public key from reconstructed key should match the session pkAggHex
    const derivedPkAggHex = getPublicKey(combinedKey1);
    expect(derivedPkAggHex).toBe(sessionData.pkAggHex);
  });
});
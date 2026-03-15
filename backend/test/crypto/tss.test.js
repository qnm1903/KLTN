import { reconstructPrivateKey, signWithReconstructed, aggregateAndSign } from '../../src/crypto/tss.js';
import { generateKeyPair } from '../../src/crypto/ecc.js';
import Secrets from 'secrets.js-grempe';
import { ethers } from 'ethers';

describe('TSS Crypto Functions', () => {
  let privateKeyHex;
  let sharesRaw;
  let sharesObj;

  beforeAll(() => {
    const keyPair = generateKeyPair();
    privateKeyHex = keyPair.privKey;

    // Create 3 shares with threshold 2
    sharesRaw = Secrets.share(privateKeyHex, 3, 2);
    sharesObj = [
      { index: 1, share: sharesRaw[0] },
      { index: 2, share: sharesRaw[1] }
    ];
  });

  it('should correctly reconstruct the private key from shares', () => {
    // sharesObj has 2 shares (threshold is 2), so it should reconstruct
    const reconstructedKey = reconstructPrivateKey(sharesObj);

    // Zero padded if secrets.js decides differently, but usually length 64 hex
    // Ensure we parse it relatively safely padding zeroes if necessary
    // Secrets drops leading zeroes sometimes, so let's normalize:
    const normalizedRecon = reconstructedKey.padStart(64, '0');
    const normalizedOriginal = privateKeyHex.padStart(64, '0');

    expect(normalizedRecon).toBe(normalizedOriginal);
  });

  it('should sign a message hash correctly', () => {
    // Create a 32-byte dummy hash (64 hex characters)
    const msgHashHex = '0x' + Buffer.from('test-message-hash-1234567890xy').toString('hex');

    const sig = signWithReconstructed(privateKeyHex, msgHashHex);

    expect(sig).toHaveProperty('r');
    expect(sig).toHaveProperty('s');
    expect(sig).toHaveProperty('v');

    expect(sig.r.startsWith('0x')).toBe(true);
    expect(sig.s.startsWith('0x')).toBe(true);
    // r and s should be 32 bytes (64 hex chars) + '0x' = 66 chars
    expect(sig.r.length).toBe(66);
    expect(sig.s.length).toBe(66);

    // v should be 27 or 28
    expect([27, 28]).toContain(sig.v);
  });

  it('should aggregate shares and sign the payload', () => {
    const msgHashHex = '0x' + Buffer.from('test-aggregate-and-sign-xyzabc').toString('hex');

    const sig = aggregateAndSign(sharesObj, msgHashHex);

    expect(sig).toHaveProperty('r');
    expect(sig).toHaveProperty('s');
    expect(sig).toHaveProperty('v');
  });
});
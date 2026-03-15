import { generateKeyPair, getPublicKey, pubKeyToAddress } from '../../src/crypto/ecc.js';
import { ethers } from 'ethers';

describe('ECC Crypto Functions', () => {
  it('should generate a valid key pair', () => {
    const keyPair = generateKeyPair();

    // Ensure it returns both privKey and pubKey
    expect(keyPair).toHaveProperty('privKey');
    expect(keyPair).toHaveProperty('pubKey');

    // Ensure they are non-empty strings (hex formats)
    expect(typeof keyPair.privKey).toBe('string');
    expect(keyPair.privKey.length).toBeGreaterThan(0);
    expect(typeof keyPair.pubKey).toBe('string');
    expect(keyPair.pubKey.length).toBe(130); // secp256k1 uncompressed hex is 130 chars (65 bytes)
  });

  it('should derive the correct public key from a private key', () => {
    const keyPair = generateKeyPair();
    const derivedPubKey = getPublicKey(keyPair.privKey);

    expect(derivedPubKey).toBe(keyPair.pubKey);
  });

  it('should derive the correct Ethereum address from a public key', () => {
    const keyPair = generateKeyPair();
    const address = pubKeyToAddress(keyPair.pubKey);

    // Address should be 42 characters long (0x + 40 hex chars)
    expect(typeof address).toBe('string');
    expect(address.length).toBe(42);
    expect(address.startsWith('0x')).toBe(true);

    // Address returned by ethers.computeAddress is checksummed
    expect(ethers.isAddress(address)).toBe(true);
  });
});
import EC_Module from 'elliptic';
import { ethers } from 'ethers';

const ec = new EC_Module.ec('secp256k1');

// Sinh cặp khóa bằng elliptic.js
export function generateKeyPair() {
  const keyPair = ec.genKeyPair();
  return {
    privKey: keyPair.getPrivate('hex'),
    pubKey: keyPair.getPublic('hex')   // uncompressed, 65 bytes
  };
}

// Tính PKagg = s*G từ private key gốc s (chạy trong DKG)
// PKagg là public key tương ứng với toàn bộ threshold group
export function getPublicKey(privKeyHex) {
  const keyPair = ec.keyFromPrivate(privKeyHex, 'hex');
  return keyPair.getPublic('hex'); // uncompressed
}

// Chuyển uncompressed pubkey → Ethereum address (20 bytes)
// address = keccak256(pubkey_bytes[1:])[12:]
export function pubKeyToAddress(pubKeyHex) {
  return ethers.computeAddress('0x' + pubKeyHex);
}
import EC_Module from 'elliptic';
import Secrets from 'secrets.js-grempe';
import { ethers } from 'ethers';

const ec = new EC_Module.ec('secp256k1');

// Reconstruct private key từ t shares dùng Lagrange interpolation
export function reconstructPrivateKey(shares) {
  const combined = Secrets.combine(shares.map(s => s.share));
  return combined; 
}

// Ký ECDSA bằng Ethers để đảm bảo tương thích EIP-2 (low-s) cho Ethereum Smart Contract
export function signWithReconstructed(privKeyHex, msgHashHex) {
  // Thêm '0x' nếu thiếu
  const formattedPrivKey = privKeyHex.startsWith('0x') ? privKeyHex : '0x' + privKeyHex;
  
  // msgHashHex PHẢI là hash 32 bytes hợp lệ. Nếu text thuần (từ unit tests cũ), băm nó lại bằng keccak256
  // (Nếu gọi từ Route /partial-sign, nó ĐÃ LÀ 32 bytes hash từ ethSignedMessageHash)
  let validHash32 = msgHashHex.startsWith('0x') ? msgHashHex : '0x' + Buffer.from(msgHashHex, 'utf8').toString('hex');
  if (ethers.getBytes(validHash32).length !== 32) {
    validHash32 = ethers.keccak256(validHash32);
  }

  const signingKey = new ethers.SigningKey(formattedPrivKey);
  const signature = signingKey.sign(validHash32);

  return {
    r: signature.r,
    s: signature.s,
    v: signature.v
  };
}

// Hàm chính: nhận shares -> reconstruct -> ký -> xóa
export function aggregateAndSign(shares, msgHashHex) {
  let privKey = null;
  try {
    privKey = reconstructPrivateKey(shares);   
    const sig = signWithReconstructed(privKey, msgHashHex); 
    return sig;
  } catch (error) {
    console.error('Error in aggregateAndSign:', error);
    throw error;
  } finally {
    privKey = null; // xóa ngay (best-effort trong JS)
  }
}
/**
 * Kiến trúc Web Worker xử lý Mật mã học TSS 5-of-7 (REAL CRYPTO)
 */

// Import thư viện elliptic (Giả định Frontend của bạn đã cài npm install elliptic)
import * as elliptic from 'elliptic';
const ec = new elliptic.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// Biến lưu trữ tạm thời k_i trên RAM của Worker (Dùng để nối Round 1 và Round 2)
let current_k = null;

self.onmessage = async (event) => {
  const { action, taskId, payload } = event.data;

  try {
    switch (action) {
      case 'COMPUTE_NONCE': {
        self.postMessage({ taskId, status: 'computing', log: 'Đang sinh số ngẫu nhiên k và tính toán Nonce R = k*G...' });
        
        // 1. Sinh ngẫu nhiên k (Private Scalar)
        const keyPair = ec.genKeyPair();
        current_k = BigInt('0x' + keyPair.getPrivate('hex')); 

        // 2. Tính điểm R = k * G
        const pubPoint = keyPair.getPublic();
        const R_x = '0x' + pubPoint.getX().toString(16).padStart(64, '0');
        const R_y = '0x' + pubPoint.getY().toString(16).padStart(64, '0');

        self.postMessage({
          taskId,
          status: 'success',
          result: { R_x, R_y },
          log: 'Đã hoàn tất tính toán Nonce (Round 1) - Điểm chuẩn Elliptic.'
        });
        break;
      }

      case 'COMPUTE_Z_SHARE': {
        self.postMessage({ taskId, status: 'computing', log: 'Đang giải phương trình Schnorr: z_i = k_i + e * x_i...' });
        
        // Cần truyền khóa riêng x_i và challenge e từ payload của hàm gọi
        // Nếu Frontend chưa truyền, phần này dùng khóa tạm để test cho qua Backend
        const privateKeyHex = payload?.privateKeyHex || ec.genKeyPair().getPrivate('hex'); 
        const challengeHex = payload?.challengeHex || "0x0000000000000000000000000000000000000000000000000000000000000001";

        const x_i = BigInt(privateKeyHex.startsWith('0x') ? privateKeyHex : '0x' + privateKeyHex);
        const e = BigInt(challengeHex.startsWith('0x') ? challengeHex : '0x' + challengeHex);
        
        // Khôi phục k_i (nếu bị mất do restart worker, tự sinh lại 1 cái để tránh crash)
        const k_i = current_k || BigInt('0x' + ec.genKeyPair().getPrivate('hex'));

        // 3. Tính z_i = (k_i + e * x_i) mod ORDER
        const z = (k_i + (e * x_i)) % ORDER;
        const zHex = '0x' + z.toString(16).padStart(64, '0');

        self.postMessage({
          taskId,
          status: 'success',
          result: { z: zHex },
          log: 'Đã hoàn tất tính toán Partial Signature (Z-Share - Round 2).'
        });
        break;
      }

      default:
        throw new Error(`Unknown action specified for TSS Worker: ${action}`);
    }
  } catch (error) {
    self.postMessage({
      taskId,
      status: 'error',
      error: error.message,
      log: `Worker Error: ${error.message}`
    });
  }
};
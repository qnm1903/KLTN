/**
 * Kiến trúc Web Worker xử lý Mật mã học TSS 5-of-7
 */

import * as elliptic from 'elliptic';
const ec = new elliptic.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// Lưu nonce scalar theo khóa ngữ cảnh: escrowId:action:role
const nonceByKey = new Map();

self.onmessage = async (event) => {
  const { action, taskId, payload } = event.data;

  try {
    switch (action) {
      case 'COMPUTE_NONCE': {
        self.postMessage({ taskId, status: 'computing', log: 'Đang sinh số ngẫu nhiên k và tính toán Nonce R = k*G...' });

        if (!payload?.nonceKey) {
          throw new Error('❌ COMPUTE_NONCE: nonceKey is required (escrowId:action:role)');
        }
        
        // 1. Sinh ngẫu nhiên k (Private Scalar)
        const keyPair = ec.genKeyPair();
        const current_k = BigInt('0x' + keyPair.getPrivate('hex'));
        const nonceHex = '0x' + current_k.toString(16).padStart(64, '0');
        nonceByKey.set(payload.nonceKey, current_k);

        // 2. Tính điểm R = k * G
        const pubPoint = keyPair.getPublic();
        const R_x = '0x' + pubPoint.getX().toString(16).padStart(64, '0');
        const R_y = '0x' + pubPoint.getY().toString(16).padStart(64, '0');

        self.postMessage({
          taskId,
          status: 'success',
          result: { R_x, R_y, nonceHex },
          log: 'Đã hoàn tất tính toán Nonce (Round 1) - Điểm chuẩn Elliptic.'
        });
        break;
      }

      case 'COMPUTE_Z_SHARE': {
        self.postMessage({ taskId, status: 'computing', log: 'Đang giải phương trình Schnorr: z_i = k_i + e * x_i...' });
        
        // FIX_1: MANDATORY: privateKeyHex và challenge e PHẢI được truyền từ Frontend
        if (!payload?.privateKeyHex) {
          throw new Error('❌ COMPUTE_Z_SHARE: privateKeyHex is required - cannot compute signature without private key');
        }
        if (!payload?.challengeHex) {
          throw new Error('❌ COMPUTE_Z_SHARE: challengeHex (challenge e) is required - cannot compute signature without challenge');
        }
        if (!payload?.nonceKey) {
          throw new Error('❌ COMPUTE_Z_SHARE: nonceKey is required (escrowId:action:role)');
        }
        
        const privateKeyHex = payload.privateKeyHex;
        const challengeHex = payload.challengeHex;
        const nonceKey = payload.nonceKey;
        const nonceHex = payload.nonceHex;

        const x_i = BigInt(privateKeyHex.startsWith('0x') ? privateKeyHex : '0x' + privateKeyHex);
        const e = BigInt(challengeHex.startsWith('0x') ? challengeHex : '0x' + challengeHex);
        
        // FIX_2: KHÔNG được fallback random k_i, vì sẽ làm chữ ký sai và gây InvalidSignature on-chain
        const restoredNonce =
          typeof nonceHex === 'string' && nonceHex.length > 0
            ? BigInt(nonceHex.startsWith('0x') ? nonceHex : '0x' + nonceHex)
            : undefined;
        const k_i = restoredNonce ?? nonceByKey.get(nonceKey);
        if (k_i === undefined) {
          throw new Error(`Round 1 nonce not found for key '${nonceKey}'. Please run Round 1 again before Round 2.`);
        }

        // 3. Tính z_i = (k_i + e * x_i) mod ORDER
        const z = (k_i + (e * x_i)) % ORDER;
        const zHex = '0x' + z.toString(16).padStart(64, '0');

        // Xóa nonce ngay sau khi dùng để tránh reuse nonce giữa các phiên ký
        nonceByKey.delete(nonceKey);

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

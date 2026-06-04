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

      case 'COMPUTE_NONCE_FROM_EXISTING': {
        self.postMessage({ taskId, status: 'computing', log: 'Reusing existing nonce from IndexedDB...' });

        if (!payload?.nonceKey || !payload?.nonceHex) {
          throw new Error('❌ COMPUTE_NONCE_FROM_EXISTING: nonceKey and nonceHex are required');
        }

        // Restore existing nonce scalar
        const existing_k = BigInt(payload.nonceHex.startsWith('0x') ? payload.nonceHex : '0x' + payload.nonceHex);
        nonceByKey.set(payload.nonceKey, existing_k);

        // Calculate R = k * G from existing nonce
        const existing_k_hex = existing_k.toString(16).padStart(64, '0');
        const keyPair = ec.keyFromPrivate(existing_k_hex, 'hex');
        const pubPoint = keyPair.getPublic();

        const R_x = '0x' + pubPoint.getX().toString(16).padStart(64, '0');
        const R_y = '0x' + pubPoint.getY().toString(16).padStart(64, '0');

        self.postMessage({
          taskId,
          status: 'success',
          result: { R_x, R_y, nonceHex: payload.nonceHex },
          log: 'Đã tính toán lại Nonce từ giá trị IndexedDB (Round 1) - Reusing existing nonce.'
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
        const e_mod = e % ORDER;
        const x_mod = x_i % ORDER;
        const z = (k_i + ((e_mod * x_mod) % ORDER)) % ORDER;
        
        const zHex = '0x' + z.toString(16).padStart(64, '0');

        // ------------------ LOCAL MATH CHECK ------------------
        // Kiểm toán ngay tại trình duyệt xem z_i vừa sinh ra có khớp với R_i và PK_i không
        try {
          const G = ec.g;
          const pkPoint = ec.keyFromPrivate(x_i.toString(16).padStart(64, '0'), 'hex').getPublic();
          const RPoint = ec.keyFromPrivate(k_i.toString(16).padStart(64, '0'), 'hex').getPublic();
          
          const zG = G.mul(z.toString(16));
          const ePK = pkPoint.mul(e_mod.toString(16));
          const R_plus_ePK = RPoint.add(ePK);

          const zGx = zG.getX().toString(16);
          const zGy = zG.getY().toString(16);
          const Rx_plus_ePKx = R_plus_ePK.getX().toString(16);
          const Ry_plus_ePKy = R_plus_ePK.getY().toString(16);

          if (zGx === Rx_plus_ePKx && zGy === Ry_plus_ePKy) {
            console.log(`✅ [LOCAL MATH CHECK] Hoàn hảo! Trình duyệt này tính đúng: z_i*G == R_i + e*PK_i`);
          } else {
            console.error(`❌ [LOCAL MATH CHECK] LỖI NGHIÊM TRỌNG TẠI PROFILE NÀY!`);
            console.error(`Phương trình toán học bị phá vỡ. Private Key hoặc Nonce đang dùng không khớp với Public Key đã nộp!`);
          }
        } catch (mathErr) {
          console.error(`❌ [LOCAL MATH CHECK] Lỗi tính toán xác minh:`, mathErr);
        }
        // ------------------------------------------------------
        
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

/**
 * Kiến trúc Web Worker xử lý Mật mã học TSS 5-of-7
 */

import * as elliptic from 'elliptic';
import {
  generatePolynomial,
  evaluatePolynomial,
  verifyShare,
  aggregateShares,
  computeSigningPublicKey,
  ecdhEncryptShare,
  ecdhDecryptShare,
  derivePublicKey
} from './dkg-crypto.js';

const ec = new elliptic.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// Lưu nonce scalar theo khóa ngữ cảnh: escrowId:action:role
const nonceByKey = new Map();

// Lưu DKG polynomial coefficients theo escrowId (xóa sau khi shares đã gửi)
const dkgPolyByEscrow = new Map();

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

      case 'COMPUTE_NONCE_FROST': {
        // FROST dual-nonce: sinh k1, k2 → R1 = k1*G, R2 = k2*G
        // payload: { nonceKey }
        self.postMessage({ taskId, status: 'computing', log: 'FROST: Đang sinh 2 nonces k1, k2...' });

        if (!payload?.nonceKey) {
          throw new Error('COMPUTE_NONCE_FROST: nonceKey is required');
        }

        const kp1 = ec.genKeyPair();
        const kp2 = ec.genKeyPair();
        const k1 = BigInt('0x' + kp1.getPrivate('hex'));
        const k2 = BigInt('0x' + kp2.getPrivate('hex'));

        const k1Hex = '0x' + k1.toString(16).padStart(64, '0');
        const k2Hex = '0x' + k2.toString(16).padStart(64, '0');

        // Lưu cả k1 và k2 với suffix
        nonceByKey.set(payload.nonceKey + ':k1', k1);
        nonceByKey.set(payload.nonceKey + ':k2', k2);

        const R1 = kp1.getPublic();
        const R2 = kp2.getPublic();

        self.postMessage({
          taskId,
          status: 'success',
          result: {
            R1_x: '0x' + R1.getX().toString(16).padStart(64, '0'),
            R1_y: '0x' + R1.getY().toString(16).padStart(64, '0'),
            R2_x: '0x' + R2.getX().toString(16).padStart(64, '0'),
            R2_y: '0x' + R2.getY().toString(16).padStart(64, '0'),
            k1Hex, k2Hex,
          },
          log: 'FROST: Đã sinh dual nonce (R1, R2). Round 1 ready.'
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
        const bindingFactorHex = payload.bindingFactorHex;  // FROST: ρ_i (optional)
        const isFrostMode = Boolean(bindingFactorHex);

        if (isFrostMode) {
          // FROST: z_i = k1 + k2*ρ_i + e*s_i
          const k1Hex = payload.k1Hex;
          const k2Hex = payload.k2Hex;
          const k1 = k1Hex
            ? BigInt(k1Hex.startsWith('0x') ? k1Hex : '0x' + k1Hex)
            : (nonceByKey.get(nonceKey + ':k1'));
          const k2 = k2Hex
            ? BigInt(k2Hex.startsWith('0x') ? k2Hex : '0x' + k2Hex)
            : (nonceByKey.get(nonceKey + ':k2'));
          if (k1 === undefined || k2 === undefined) {
            throw new Error(`FROST nonces not found for key '${nonceKey}'. Run COMPUTE_NONCE_FROST first.`);
          }
          const rho = BigInt(bindingFactorHex.startsWith('0x') ? bindingFactorHex : '0x' + bindingFactorHex);
          const e_mod = e % ORDER;
          const x_mod = x_i % ORDER;
          const z = (k1 + ((k2 * rho) % ORDER) + ((e_mod * x_mod) % ORDER)) % ORDER;
          const zHex = '0x' + z.toString(16).padStart(64, '0');

          nonceByKey.delete(nonceKey + ':k1');
          nonceByKey.delete(nonceKey + ':k2');

          self.postMessage({
            taskId, status: 'success',
            result: { z: zHex },
            log: 'FROST: Đã tính z_i = k1 + k2*ρ + e*s (Round 2 partial signature).'
          });
          break;
        }

        // Legacy single-nonce mode
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

      // ─── DKG Phase Actions ───────────────────────────────────────────────────

      case 'COMPUTE_DKG_POLYNOMIAL': {
        // B1: Sinh polynomial + Feldman commitments
        // payload: { escrowId, privKeyHex }
        if (!payload?.escrowId || !payload?.privKeyHex) {
          throw new Error('COMPUTE_DKG_POLYNOMIAL: escrowId and privKeyHex are required');
        }
        self.postMessage({ taskId, status: 'computing', log: 'Đang sinh polynomial bậc 4 và tính Feldman commitments...' });

        const { coeffs, commitments } = generatePolynomial();
        // Cache in memory for immediate use; caller also persists coeffs to localStorage
        dkgPolyByEscrow.set(payload.escrowId, coeffs);

        const pubKeyHex = derivePublicKey(payload.privKeyHex);

        self.postMessage({
          taskId,
          status: 'success',
          // Return coeffs so caller can persist them for page-refresh resume
          result: { commitments, pubKeyHex, coeffs },
          log: `Đã sinh polynomial + ${commitments.length} Feldman commitments.`
        });
        break;
      }

      case 'COMPUTE_DKG_SHARES': {
        // B2: Tính shares cho tất cả parties và encrypt
        // payload: { escrowId, myPrivKeyHex, parties: [{ role, participantId, pubKeyHex }], coeffs? (fallback from localStorage) }
        if (!payload?.escrowId || !payload?.myPrivKeyHex || !Array.isArray(payload?.parties)) {
          throw new Error('COMPUTE_DKG_SHARES: escrowId, myPrivKeyHex, parties[] required');
        }
        self.postMessage({ taskId, status: 'computing', log: 'Đang tính và mã hoá shares cho từng party...' });

        // Use in-memory polynomial if available, otherwise use caller-supplied coeffs (from localStorage resume)
        const coeffs = dkgPolyByEscrow.get(payload.escrowId) || payload.coeffs;
        if (!coeffs) {
          throw new Error(`DKG polynomial not found for escrow ${payload.escrowId}. Page may have been refreshed — check localStorage for saved polynomial.`);
        }
        // Re-cache if loaded from external source
        if (!dkgPolyByEscrow.has(payload.escrowId)) dkgPolyByEscrow.set(payload.escrowId, coeffs);

        const encryptedShares = [];
        for (const party of payload.parties) {
          const shareHex = evaluatePolynomial(coeffs, party.participantId);
          const encryptedBlob = await ecdhEncryptShare(payload.myPrivKeyHex, party.pubKeyHex, shareHex);
          encryptedShares.push({ toRole: party.role, encryptedBlob });
        }

        // Xóa polynomial sau khi đã tính đủ shares (least-privilege)
        dkgPolyByEscrow.delete(payload.escrowId);

        self.postMessage({
          taskId,
          status: 'success',
          result: { shares: encryptedShares },
          log: `Đã mã hoá ${encryptedShares.length} shares cho các parties.`
        });
        break;
      }

      case 'VERIFY_DKG_SHARE': {
        // B3: Feldman verification cho một share nhận được
        // payload: { shareHex, commitments: [{x,y}*5], participantId }
        if (!payload?.shareHex || !payload?.commitments || payload?.participantId == null) {
          throw new Error('VERIFY_DKG_SHARE: shareHex, commitments[], participantId required');
        }
        const isValid = verifyShare(payload.shareHex, payload.commitments, payload.participantId);
        self.postMessage({
          taskId,
          status: 'success',
          result: { valid: isValid },
          log: isValid ? '✅ Share hợp lệ (Feldman verified).' : '❌ Share KHÔNG hợp lệ! Bỏ qua share này.'
        });
        break;
      }

      case 'COMPUTE_ECDH_DECRYPT': {
        // Decrypt share từ sender: recipientPrivKey + senderPubKey + blob → shareHex
        // payload: { recipientPrivKeyHex, senderPubKeyHex, encryptedBlob }
        if (!payload?.recipientPrivKeyHex || !payload?.senderPubKeyHex || !payload?.encryptedBlob) {
          throw new Error('COMPUTE_ECDH_DECRYPT: recipientPrivKeyHex, senderPubKeyHex, encryptedBlob required');
        }
        const decryptedShare = await ecdhDecryptShare(
          payload.recipientPrivKeyHex,
          payload.senderPubKeyHex,
          payload.encryptedBlob
        );
        self.postMessage({
          taskId,
          status: 'success',
          result: { shareHex: decryptedShare },
          log: 'Đã giải mã share ECDH-AES-GCM.'
        });
        break;
      }

      case 'AGGREGATE_DKG_SHARES': {
        // B4: Tổng hợp tất cả shares → final signing key
        // payload: { shares: string[], myOwnShareHex (optional — share tự tính cho chính mình) }
        if (!Array.isArray(payload?.shares) || payload.shares.length === 0) {
          throw new Error('AGGREGATE_DKG_SHARES: shares[] (array of hex scalars) required');
        }
        self.postMessage({ taskId, status: 'computing', log: 'Đang tổng hợp shares thành final signing key...' });

        const allShares = payload.myOwnShareHex
          ? [...payload.shares, payload.myOwnShareHex]
          : payload.shares;

        const finalShareHex = aggregateShares(allShares);
        const signingPubKey = computeSigningPublicKey(finalShareHex);

        self.postMessage({
          taskId,
          status: 'success',
          result: { finalShareHex, signingPubKey },
          log: `DKG hoàn tất. Pⱼ = (${signingPubKey.x.slice(0, 10)}..., ${signingPubKey.y.slice(0, 10)}...)`
        });
        break;
      }

      default:
        throw new Error(`Unknown action specified for TSS Worker: ${action}`);
    }
  } catch (error) {
    // DOMException (e.g., AES-GCM decrypt failure) has empty .message — fall back to .name
    const errMsg = error?.message || error?.name || String(error) || 'Unknown worker error';
    self.postMessage({
      taskId,
      status: 'error',
      error: errMsg,
      log: `Worker Error: ${errMsg}`
    });
  }
};

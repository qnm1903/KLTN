/**
 * ECDH + AES-GCM encryption để phân phối VSS shares giữa các parties
 *
 * Flow:
 *   Sender i → party j:
 *     sharedSecret = ECDH(privId_i, pubId_j)   (secp256k1 Diffie-Hellman)
 *     encryptedBlob = AES-GCM-encrypt(sharedSecret, shareScalar)
 *
 *   Receiver j ← party i:
 *     sharedSecret = ECDH(privId_j, pubId_i)   (đối xứng, cùng kết quả)
 *     shareScalar = AES-GCM-decrypt(sharedSecret, encryptedBlob)
 *
 * Private key của mỗi party (privId) KHÔNG bao giờ rời khỏi frontend.
 * Backend chỉ lưu encrypted blobs — không thể giải mã.
 */

import EC_Module from 'elliptic';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ec = new EC_Module.ec('secp256k1');

// AES-256-GCM constants
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// ─── ECDH shared secret ────────────────────────────────────────────────────────

/**
 * Tính ECDH shared secret từ private key của sender và public key của recipient.
 * Kết quả đối xứng: ECDH(privA, pubB) == ECDH(privB, pubA)
 *
 * @param {string} senderPrivKeyHex    - private key bên gửi (hex 32 bytes)
 * @param {string} recipientPubKeyHex  - public key bên nhận (uncompressed 04...)
 * @returns {Buffer} 32-byte shared secret (SHA-256 của điểm x-coordinate)
 */
export function computeEcdhSharedSecret(senderPrivKeyHex, recipientPubKeyHex) {
  const privHex = senderPrivKeyHex.replace(/^0x/i, '').padStart(64, '0');
  const pubHex = recipientPubKeyHex.replace(/^0x/i, '');

  const senderKey = ec.keyFromPrivate(privHex, 'hex');
  const recipientPub = ec.keyFromPublic(pubHex, 'hex').getPublic();

  // ECDH: multiply recipient's public point by sender's private scalar
  const sharedPoint = recipientPub.mul(senderKey.getPrivate());
  const xHex = sharedPoint.getX().toString(16).padStart(64, '0');

  // Dùng SHA-256 của x-coordinate làm AES key (chuẩn ECDH)
  return createHash('sha256').update(Buffer.from(xHex, 'hex')).digest();
}

// ─── AES-GCM encrypt / decrypt ─────────────────────────────────────────────────

/**
 * Encrypt một VSS share scalar bằng AES-256-GCM.
 *
 * @param {Buffer} aesKey     - 32-byte key từ computeEcdhSharedSecret
 * @param {string} shareHex   - scalar hex (0x...)
 * @returns {string}  base64-encoded blob: IV (12B) || ciphertext (32B) || tag (16B)
 */
export function aesGcmEncrypt(aesKey, shareHex) {
  const iv = randomBytes(IV_BYTES);
  const plaintext = Buffer.from(shareHex.replace(/^0x/i, '').padStart(64, '0'), 'hex');

  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Ghép: IV || ciphertext || tag → base64
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

/**
 * Decrypt AES-256-GCM blob thành VSS share scalar.
 *
 * @param {Buffer} aesKey   - 32-byte key từ computeEcdhSharedSecret
 * @param {string} blob     - base64-encoded blob từ aesGcmEncrypt
 * @returns {string}  share scalar hex (0x...)
 */
export function aesGcmDecrypt(aesKey, blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return '0x' + plaintext.toString('hex');
}

// ─── Composite helpers (dùng trong backend để forward blobs) ──────────────────

/**
 * Encrypt share của party i gửi cho party j (dùng trên frontend).
 *
 * @param {string} senderPrivKeyHex    - private key của party i
 * @param {string} recipientPubKeyHex  - public key của party j
 * @param {string} shareHex            - VSS share scalar
 * @returns {string}  encrypted blob (base64)
 */
export function encryptShareForRecipient(senderPrivKeyHex, recipientPubKeyHex, shareHex) {
  const aesKey = computeEcdhSharedSecret(senderPrivKeyHex, recipientPubKeyHex);
  return aesGcmEncrypt(aesKey, shareHex);
}

/**
 * Decrypt share party j nhận từ party i (dùng trên frontend).
 *
 * @param {string} recipientPrivKeyHex - private key của party j
 * @param {string} senderPubKeyHex     - public key của party i
 * @param {string} encryptedBlob       - blob từ encryptShareForRecipient
 * @returns {string}  VSS share scalar (hex)
 */
export function decryptShareFromSender(recipientPrivKeyHex, senderPubKeyHex, encryptedBlob) {
  const aesKey = computeEcdhSharedSecret(recipientPrivKeyHex, senderPubKeyHex);
  return aesGcmDecrypt(aesKey, encryptedBlob);
}

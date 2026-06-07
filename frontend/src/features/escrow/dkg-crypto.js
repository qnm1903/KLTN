/**
 * Browser-compatible DKG crypto (Pedersen VSS + ECDH-AES)
 * Dùng cho Web Worker — không import Node.js modules
 * Sử dụng: elliptic (bundled) + Web Crypto API (crypto.subtle)
 */

import * as elliptic from 'elliptic';
const ec = new elliptic.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const THRESHOLD = 5;

// ─── Scalar helpers ────────────────────────────────────────────────────────────

function randomScalar() {
  let scalar;
  do {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    scalar = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  } while (scalar === 0n || scalar >= ORDER);
  return scalar;
}

function scalarToHex(s) {
  return '0x' + s.toString(16).padStart(64, '0');
}

function hexToScalar(hex) {
  return BigInt(typeof hex === 'string' && hex.startsWith('0x') ? hex : '0x' + hex);
}

function pointToCoords(point) {
  return {
    x: '0x' + point.getX().toString(16).padStart(64, '0'),
    y: '0x' + point.getY().toString(16).padStart(64, '0'),
  };
}

function coordsToPoint(coords) {
  const x = coords.x.replace(/^0x/i, '').padStart(64, '0');
  const y = coords.y.replace(/^0x/i, '').padStart(64, '0');
  return ec.keyFromPublic('04' + x + y, 'hex').getPublic();
}

function pointMul(point, scalar) {
  const s = ((scalar % ORDER) + ORDER) % ORDER;
  return point.mul(s.toString(16));
}

// ─── Pedersen VSS ──────────────────────────────────────────────────────────────

/**
 * Sinh polynomial bậc 4 và tính Feldman commitments
 * @returns {{ coeffs: string[], commitments: {x,y}[] }}
 */
export function generatePolynomial() {
  const coeffs = [];
  for (let j = 0; j < THRESHOLD; j++) {
    coeffs.push(scalarToHex(randomScalar()));
  }
  const G = ec.g;
  const commitments = coeffs.map(coeff => {
    const scalar = hexToScalar(coeff);
    return pointToCoords(pointMul(G, scalar));
  });
  return { coeffs, commitments };
}

/**
 * Tính share đóng góp cho party j: sᵢⱼ = fᵢ(participantId)
 */
export function evaluatePolynomial(coeffs, participantId) {
  const x = BigInt(participantId);
  let result = 0n;
  let xPow = 1n;
  for (const coeff of coeffs) {
    result = (result + hexToScalar(coeff) * xPow) % ORDER;
    xPow = (xPow * x) % ORDER;
  }
  return scalarToHex(result);
}

/**
 * Feldman verification: sᵢⱼ * G == Σₖ Cᵢₖ * j_id^k
 */
export function verifyShare(shareHex, commitments, participantId) {
  if (!commitments || commitments.length !== THRESHOLD) return false;
  const G = ec.g;
  const share = hexToScalar(shareHex);
  const x = BigInt(participantId);
  const sharePoint = pointMul(G, share);
  let expectedPoint = null;
  let xPow = 1n;
  for (const c of commitments) {
    const Cik = coordsToPoint(c);
    const term = pointMul(Cik, xPow);
    expectedPoint = expectedPoint ? expectedPoint.add(term) : term;
    xPow = (xPow * x) % ORDER;
  }
  if (!expectedPoint) return false;
  const sp = pointToCoords(sharePoint);
  const ep = pointToCoords(expectedPoint);
  return sp.x.toLowerCase() === ep.x.toLowerCase() && sp.y.toLowerCase() === ep.y.toLowerCase();
}

/**
 * Tổng hợp final signing share: sⱼ = Σᵢ sᵢⱼ
 */
export function aggregateShares(shares) {
  const sum = shares.reduce((acc, s) => (acc + hexToScalar(s)) % ORDER, 0n);
  return scalarToHex(sum);
}

/**
 * Tính final signing public key: Pⱼ = sⱼ * G
 */
export function computeSigningPublicKey(finalShareHex) {
  const G = ec.g;
  return pointToCoords(pointMul(G, hexToScalar(finalShareHex)));
}

// ─── ECDH + AES-GCM (Web Crypto API) ─────────────────────────────────────────

/**
 * Tính ECDH shared secret: SHA-256 của x-coordinate của senderPrivKey * recipientPubKey
 * @returns {CryptoKey} AES-256-GCM key
 */
async function computeEcdhAesKey(privKeyHex, otherPubKeyHex) {
  const privHex = privKeyHex.replace(/^0x/i, '').padStart(64, '0');
  const pubHex = otherPubKeyHex.replace(/^0x/i, '');

  const senderKey = ec.keyFromPrivate(privHex, 'hex');
  const recipientPub = ec.keyFromPublic(pubHex, 'hex').getPublic();
  const sharedPoint = recipientPub.mul(senderKey.getPrivate());
  const xHex = sharedPoint.getX().toString(16).padStart(64, '0');
  const xBytes = new Uint8Array(xHex.match(/.{2}/g).map(b => parseInt(b, 16)));

  const hashBuf = await crypto.subtle.digest('SHA-256', xBytes);
  return crypto.subtle.importKey('raw', hashBuf, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt share bằng ECDH-AES-256-GCM
 * @param {string} senderPrivKeyHex
 * @param {string} recipientPubKeyHex - uncompressed EC point (04...)
 * @param {string} shareHex
 * @returns {string} base64 blob: IV(12B) || ciphertext(32B) || tag(16B)
 */
export async function ecdhEncryptShare(senderPrivKeyHex, recipientPubKeyHex, shareHex) {
  const aesKey = await computeEcdhAesKey(senderPrivKeyHex, recipientPubKeyHex);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plainHex = shareHex.replace(/^0x/i, '').padStart(64, '0');
  const plainBytes = new Uint8Array(plainHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plainBytes);
  // cipherBuf = ciphertext(32B) + tag(16B) in Web Crypto
  const result = new Uint8Array(12 + cipherBuf.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(cipherBuf), 12);
  return btoa(String.fromCharCode(...result));
}

/**
 * Decrypt share từ ECDH-AES-256-GCM blob
 * @param {string} recipientPrivKeyHex
 * @param {string} senderPubKeyHex
 * @param {string} blob - base64
 * @returns {string} shareHex
 */
export async function ecdhDecryptShare(recipientPrivKeyHex, senderPubKeyHex, blob) {
  const aesKey = await computeEcdhAesKey(recipientPrivKeyHex, senderPubKeyHex);
  const bytes = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const cipherAndTag = bytes.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipherAndTag);
  const plainHex = Array.from(new Uint8Array(plainBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + plainHex;
}

/**
 * Tính public key từ private key (để submit lên backend)
 * @param {string} privKeyHex
 * @returns {string} uncompressed pubkey hex (04...)
 */
export function derivePublicKey(privKeyHex) {
  const privHex = privKeyHex.replace(/^0x/i, '').padStart(64, '0');
  const keyPair = ec.keyFromPrivate(privHex, 'hex');
  return '04' + keyPair.getPublic().getX().toString(16).padStart(64, '0') +
    keyPair.getPublic().getY().toString(16).padStart(64, '0');
}

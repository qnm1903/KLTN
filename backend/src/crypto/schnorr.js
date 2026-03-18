/**
 * Schnorr Threshold Signature Scheme trên secp256k1
 *
 * Ký: z_i = k_i + e * s_i  (mod ORDER)
 * Xác minh: z*G - e*PKagg == R
 *   tức là: address(z*G - e*PKagg) == address(R)
 *
 * Không có trusted dealer. Mỗi bên tự sinh (s_i, PK_i) ở FRONTEND.
 * Backend chỉ nhận PUBLIC keys, tổng hợp R và z — không bao giờ thấy private key.
 *
 * Giao thức ký 2 vòng (2 bên tham gia từ 3):
 *   Round 1: Mỗi bên gửi R_i = k_i * G (nonce public key)
 *            Backend tổng hợp R = R_i + R_j, tính R_addr, tính challenge e
 *   Round 2: Mỗi bên tự tính z_i = k_i + e * s_i (có e rồi mới tính được)
 *            Backend tổng hợp z = z_i + z_j (mod ORDER)
 *            Chữ ký cuối: (R_addr, z, e) — gửi lên contract để verify
 */

import EC_Module from 'elliptic';
import { ethers } from 'ethers';

const ec = new EC_Module.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─── Internal helpers ──────────────────────────────────────────────────────────

function normalize64(hex) {
  return hex.replace('0x', '').padStart(64, '0');
}

function normalizePubKey(hex) {
  const clean = hex.replace('0x', '');
  if (clean.startsWith('04')) {
    return clean;
  }
  if (clean.startsWith('02') || clean.startsWith('03')) {
    throw new Error('Compressed public keys are not supported. Please provide an uncompressed key.');
  }
  if (clean.length === 128) {
    return '04' + clean;
  }
  throw new Error('Invalid public key format');
}

// Chuyển EC point (x, y) → Ethereum address = keccak256(x||y)[12:]
function pointToAddress(xHex, yHex) {
  const x = normalize64(xHex);
  const y = normalize64(yHex);
  return ethers.computeAddress('0x04' + x + y);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Tổng hợp 2 hoặc nhiều public keys (cộng điểm EC).
 * PKagg = PK_a + PK_b + ...
 *
 * @param {string[]} pubKeyHexArray - mảng uncompressed pubkeys (hex, có hoặc không có tiền tố 04)
 * @returns {{ hex: string, x: string, y: string }}
 */
export function aggregatePublicKeys(pubKeyHexArray) {
  if (pubKeyHexArray.length < 2) throw new Error('Need at least 2 public keys');

  let agg = ec.keyFromPublic(normalizePubKey(pubKeyHexArray[0]), 'hex').getPublic();
  for (let i = 1; i < pubKeyHexArray.length; i++) {
    const pt = ec.keyFromPublic(normalizePubKey(pubKeyHexArray[i]), 'hex').getPublic();
    agg = agg.add(pt);
  }

  const x = '0x' + agg.getX().toString(16).padStart(64, '0');
  const y = '0x' + agg.getY().toString(16).padStart(64, '0');
  return {
    hex: '04' + agg.getX().toString(16).padStart(64, '0') + agg.getY().toString(16).padStart(64, '0'),
    x,
    y
  };
}

/**
 * Tổng hợp các nonce points R_i từ các bên.
 * R = R_1 + R_2 + ... (cộng điểm EC)
 * Trả về R và Ethereum address của R (dùng trong challenge).
 *
 * @param {{ R_x: string, R_y: string }[]} nonces
 * @returns {{ R_x: string, R_y: string, R_addr: string }}
 */
export function aggregateNonces(nonces) {
  let R = ec.curve.point(normalize64(nonces[0].R_x), normalize64(nonces[0].R_y));
  for (let i = 1; i < nonces.length; i++) {
    const pt = ec.curve.point(normalize64(nonces[i].R_x), normalize64(nonces[i].R_y));
    R = R.add(pt);
  }

  const R_x = '0x' + R.getX().toString(16).padStart(64, '0');
  const R_y = '0x' + R.getY().toString(16).padStart(64, '0');
  const R_addr = pointToAddress(R_x, R_y);
  return { R_x, R_y, R_addr };
}

/**
 * Tính Schnorr challenge.
 * e = keccak256(R_addr || pkX || pkY || msgHash)
 * Phải nhất quán giữa frontend và backend.
 *
 * @param {string} R_addr  - address(R), 20 bytes
 * @param {string} pkX     - PKagg.x, uint256
 * @param {string} pkY     - PKagg.y, uint256
 * @param {string} msgHash - 32 bytes hex
 * @returns {string} e (bytes32 hex)
 */
export function computeChallenge(R_addr, pkX, pkY, msgHash) {
  return ethers.solidityPackedKeccak256(
    ['address', 'uint256', 'uint256', 'bytes32'],
    [R_addr, pkX, pkY, msgHash]
  );
}

/**
 * Tổng hợp các z shares thành chữ ký z cuối.
 * z = z_1 + z_2 + ... (mod ORDER)
 *
 * @param {string[]} zShares - mảng z_i (hex)
 * @returns {string} z (bytes32 hex)
 */
export function aggregateZShares(zShares) {
  const z_total = zShares
    .map(z => BigInt(z.startsWith('0x') ? z : '0x' + z))
    .reduce((a, b) => (a + b) % ORDER, 0n);
  return '0x' + z_total.toString(16).padStart(64, '0');
}

/**
 * Tính signature share của một bên.
 * z_i = (k_i + e * s_i) mod ORDER
 *
 * CHẠY Ở FRONTEND — private key (s_i) không bao giờ rời khỏi thiết bị.
 * Ở đây để backend TEST và backend dùng trong unit test (simulate frontend).
 *
 * @param {string} privKeyHex - private key của bên đó (hex 32 bytes)
 * @param {string} nonceHex   - nonce k_i (hex 32 bytes)
 * @param {string} challenge  - e (bytes32 hex)
 * @returns {{ R_x, R_y, R_addr, z }}
 */
export function computeSignatureShare(privKeyHex, nonceHex, challenge) {
  const k = BigInt('0x' + normalize64(nonceHex));
  const s = BigInt('0x' + normalize64(privKeyHex));
  const e = BigInt(challenge);

  const z = (k + e * s) % ORDER;

  const R_kp = ec.keyFromPrivate(normalize64(nonceHex), 'hex');
  const R_pub = R_kp.getPublic();

  const R_x = '0x' + R_pub.getX().toString(16).padStart(64, '0');
  const R_y = '0x' + R_pub.getY().toString(16).padStart(64, '0');
  const R_addr = pointToAddress(R_x, R_y);

  return {
    R_x,
    R_y,
    R_addr,
    z: '0x' + z.toString(16).padStart(64, '0')
  };
}

/**
 * Verify chữ ký Schnorr trong JavaScript (dùng cho test, không dùng on-chain).
 * Kiểm tra: address(z*G - e*PKagg) == R_addr
 *
 * Dùng ecrecover trick (cùng logic với Solidity _verifySchnorr):
 *   ecrecover(e*pkX mod n, parity(pkY), pkX, z*pkX mod n) = address(z*G - e*PK)
 *
 * @param {{ x: string, y: string }} pkAgg - PKagg point
 * @param {string} msgHash  - 32 bytes hex
 * @param {string} R_addr   - address(R)
 * @param {string} z        - signature scalar (bytes32)
 * @param {string} e        - challenge (bytes32)
 * @returns {boolean}
 */
export function verifySchnorr(pkAgg, msgHash, R_addr, z, e) {
  const pkX = BigInt(pkAgg.x);
  const pkY = BigInt(pkAgg.y);
  const z_val = BigInt(z);
  const e_val = BigInt(e);

  // For additive convention z = k + e*sk: verify z*G - e*PK = R
  // address(z*G - e*PK) via ecrecover trick:
  //   sp   = (-e)*pkX mod ORDER
  //   hash = (-z)*pkX mod ORDER
  //   ecrecover(hash, parity(pkY), pkX, sp) = address(z*G - e*PK) = address(R)
  const sp = ethers.toBeHex(mulmod(ORDER - e_val, pkX, ORDER), 32);
  const hash_val = ethers.toBeHex(mulmod(ORDER - z_val, pkX, ORDER), 32);
  const recid = pkY % 2n === 0n ? 0 : 1;

  const recovered = ec.recoverPubKey(
    Buffer.from(hash_val.slice(2), 'hex'),
    {
      r: ethers.toBeHex(pkX, 32).slice(2),
      s: sp.slice(2)
    },
    recid
  );

  const recoveredX = recovered.getX().toString(16).padStart(64, '0');
  const recoveredY = recovered.getY().toString(16).padStart(64, '0');
  const computed = ethers.computeAddress('0x04' + recoveredX + recoveredY);

  return computed.toLowerCase() === R_addr.toLowerCase();
}

// mulmod: (a * b) mod m
function mulmod(a, b, m) {
  return (a * b) % m;
}

export { pointToAddress };
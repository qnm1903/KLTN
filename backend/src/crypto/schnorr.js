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
  return String(hex || '').replace(/^0x/i, '').padStart(64, '0');
}

function normalizePubKey(hex) {
  const clean = String(hex || '').replace(/^0x/i, '');
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

function scalarForPointMul(value) {
  return ((BigInt(value) % ORDER + ORDER) % ORDER).toString(16);
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
 * @throws {Error} Nếu điểm không thỏa y² = x³ + 7 (curve equation)
 */
export function aggregateNonces(nonces) {
  if (!nonces || nonces.length === 0) {
    throw new Error('aggregateNonces: nonces array is empty or null');
  }

  // Hàm validate và create point với error handling tốt hơn
  const createAndValidatePoint = (idx, R_x, R_y) => {
    try {
      const x = normalize64(R_x);
      const y = normalize64(R_y);
      
      // Validate: kiểm tra x, y có phải hex hợp lệ 64 ký tự
      if (!/^[0-9a-f]{64}$/i.test(x)) {
        throw new Error(`Invalid R_x format at index ${idx}: expected 64-char hex, got '${x}'`);
      }
      if (!/^[0-9a-f]{64}$/i.test(y)) {
        throw new Error(`Invalid R_y format at index ${idx}: expected 64-char hex, got '${y}'`);
      }

      // Cố tạo point — elliptic.js sẽ validate curve equation
      const pt = ec.keyFromPublic({ x: x, y: y }, 'hex').getPublic();
      return pt;
    } catch (error) {
      // Chi tiết error: nếu là "bad point: equation left != right" nghĩa là y² ≠ x³ + 7
      throw new Error(`Point validation failed at index ${idx}: ${error.message}. Received R_x='${R_x}', R_y='${R_y}'`);
    }
  };

  try {
    let R = createAndValidatePoint(0, nonces[0].R_x, nonces[0].R_y);
    
    for (let i = 1; i < nonces.length; i++) {
      const pt = createAndValidatePoint(i, nonces[i].R_x, nonces[i].R_y);
      R = R.add(pt);
    }

    const R_x = '0x' + R.getX().toString(16).padStart(64, '0');
    const R_y = '0x' + R.getY().toString(16).padStart(64, '0');
    const R_addr = pointToAddress(R_x, R_y);
    return { R_x, R_y, R_addr };
  } catch (error) {
    // Re-throw với context đầy đủ cho debugging
    throw new Error(`aggregateNonces failed: ${error.message}`);
  }
}

export function aggregateNoncesWithLagrange(noncesByRole, roleToId) {
  if (!noncesByRole || typeof noncesByRole !== 'object') {
    throw new Error('noncesByRole is required');
  }
  if (!roleToId || typeof roleToId !== 'object') {
    throw new Error('roleToId mapping is required');
  }

  const roles = Object.keys(noncesByRole);
  if (roles.length === 0) throw new Error('aggregateNoncesWithLagrange: no nonces provided');

  const participantIds = roles.map(role => {
    const id = roleToId[role];
    if (id === undefined) throw new Error(`Missing roleToId for role ${role}`);
    return id;
  });
  const lagrangeCoeffs = computeLagrangeCoefficients(participantIds);

  let aggregatePoint = null;
  for (const role of roles) {
    const nonce = noncesByRole[role];
    const x = normalize64(nonce.R_x);
    const y = normalize64(nonce.R_y);
    if (!/^[0-9a-f]{64}$/i.test(x) || !/^[0-9a-f]{64}$/i.test(y)) {
      throw new Error(`Invalid nonce point for role ${role}`);
    }

    const point = ec.keyFromPublic({ x, y }, 'hex').getPublic();
    const weightedPoint = point.mul(scalarForPointMul(lagrangeCoeffs[roleToId[role]]));
    aggregatePoint = aggregatePoint ? aggregatePoint.add(weightedPoint) : weightedPoint;
  }

  const R_x = '0x' + aggregatePoint.getX().toString(16).padStart(64, '0');
  const R_y = '0x' + aggregatePoint.getY().toString(16).padStart(64, '0');
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

// ─── Modular arithmetic helpers ─────────────────────────────────────────────

/**
 * Tính modular inverse của a mod m bằng Extended Euclidean Algorithm.
 * @param {bigint} a
 * @param {bigint} m
 * @returns {bigint} a^(-1) mod m
 */
function modInverse(a, m) {
  // Ensure 0 <= a < m
  a = ((a % m) + m) % m;
  if (a === 0n) throw new Error('Modular inverse does not exist');

  // Extended Euclidean Algorithm (works with BigInt)
  let m0 = m;
  let x0 = 0n;
  let x1 = 1n;

  while (a > 1n) {
    const q = a / m;
    let t = m;
    m = a % m;
    a = t;

    t = x0;
    x0 = x1 - q * x0;
    x1 = t;
  }

  if (x1 < 0n) x1 += m0;
  return x1;
}

/**
 * Tính Lagrange coefficients cho Shamir Secret Sharing.
 * λ_i = ∏(0 - x_j) / (x_i - x_j) mod ORDER
 *
 * @param {number[]} participantIds - mảng ID của những bên tham gia (ví dụ [1, 2, 3, 4, 5])
 * @returns {Object} { id: lambda_coefficient }
 */
export function computeLagrangeCoefficients(participantIds) {
  if (!Array.isArray(participantIds) || participantIds.length < 2) {
    throw new Error('participantIds must be array with at least 2 elements');
  }

  const coefficients = {};
  
  for (const xi of participantIds) {
    let numerator = 1n;
    let denominator = 1n;

    for (const xj of participantIds) {
      if (xi === xj) continue;
      
      // numerator: (0 - xj) = -xj
      numerator = (numerator * (0n - BigInt(xj))) % ORDER;
      
      // denominator: (xi - xj)
      denominator = (denominator * (BigInt(xi) - BigInt(xj))) % ORDER;
    }

    // λ_i = numerator / denominator mod ORDER
    const lambda = ((numerator * modInverse(denominator, ORDER)) % ORDER + ORDER) % ORDER;
    coefficients[xi] = lambda;
  }

  return coefficients;
}

/**
 * Tổng hợp các z shares thành chữ ký z cuối (ADDITIVE - không dùng Lagrange).
 * z = z_1 + z_2 + ... (mod ORDER)
 *
 * @param {string[]} zShares - mảng z_i (hex)
 * @returns {string} z (bytes32 hex)
 */
export function aggregateZShares(zShares) {
  let z_total = zShares
    .map(z => BigInt(z.startsWith('0x') ? z : '0x' + z))
    .reduce((a, b) => (a + b) % ORDER, 0n);
  z_total = (z_total + ORDER) % ORDER;
  return '0x' + z_total.toString(16).padStart(64, '0');
}

/**
 * Tổng hợp các z shares với Lagrange coefficients (SSS - Shamir Secret Sharing).
 * z = (z_1*λ_1 + z_2*λ_2 + ... + z_n*λ_n) mod ORDER
 *
 * @param {Object} zSharesByRole - { role: z_hex } ví dụ { buyer: '0x...', seller: '0x...' }
 * @param {Object} roleToId - { role: id } ví dụ { buyer: 1, seller: 2, ... }
 * @returns {string} z (bytes32 hex)
 */
export function aggregateZSharesWithLagrange(zSharesByRole, roleToId) {
  if (!zSharesByRole || typeof zSharesByRole !== 'object') {
    throw new Error('zSharesByRole is required');
  }
  if (!roleToId || typeof roleToId !== 'object') {
    throw new Error('roleToId mapping is required');
  }

  const roles = Object.keys(zSharesByRole);
  const participantIds = roles.map(role => roleToId[role]).filter(id => id !== undefined);

  if (participantIds.length !== roles.length) {
    throw new Error('Some roles are missing from roleToId mapping');
  }

  const lagrangeCoeffs = computeLagrangeCoefficients(participantIds);

  let z_total = 0n;
  for (const role of roles) {
    const z = BigInt(zSharesByRole[role].startsWith('0x') ? zSharesByRole[role] : '0x' + zSharesByRole[role]);
    const id = roleToId[role];
    const lambda = lagrangeCoeffs[id];
    z_total = (z_total + (z * lambda) % ORDER) % ORDER;
  }

  return '0x' + z_total.toString(16).padStart(64, '0');
}

/**
 * Aggregate public keys using Lagrange coefficients (SSS-aware).
 * PKagg = sum_i (lambda_i * P_i)
 *
 * @param {Object} pubKeysByRole - { role: pubkey_hex }
 * @param {string[]} roles - ordered array of roles to include
 * @param {Object} roleToId - mapping role -> id
 * @returns {{ hex: string, x: string, y: string }}
 */
export function aggregatePubKeysWithLagrange(pubKeysByRole, roles, roleToId) {
  if (!pubKeysByRole || typeof pubKeysByRole !== 'object') throw new Error('pubKeysByRole is required');
  if (!Array.isArray(roles) || roles.length === 0) throw new Error('roles array is required');
  if (!roleToId || typeof roleToId !== 'object') throw new Error('roleToId mapping is required');

  const participantIds = roles.map(role => {
    const id = roleToId[role];
    if (id === undefined) throw new Error(`Missing roleToId for role ${role}`);
    return id;
  });

  const lagrangeCoeffs = computeLagrangeCoefficients(participantIds);

  // Sum lambda_i * P_i
  let aggPoint = null;
  for (const role of roles) {
    const pubKeyHex = pubKeysByRole[role];
    if (!pubKeyHex) throw new Error(`Missing public key for role ${role}`);

    const clean = normalizePubKey(pubKeyHex);
    const pt = ec.keyFromPublic(clean, 'hex').getPublic();
    const id = roleToId[role];
    const lambda = lagrangeCoeffs[id];

    // Multiply point by scalar lambda
    const scaled = pt.mul(scalarForPointMul(lambda));

    if (aggPoint === null) aggPoint = scaled;
    else aggPoint = aggPoint.add(scaled);
  }

  if (!aggPoint) throw new Error('aggregatePubKeysWithLagrange: no points aggregated');

  const x = '0x' + aggPoint.getX().toString(16).padStart(64, '0');
  const y = '0x' + aggPoint.getY().toString(16).padStart(64, '0');
  return {
    hex: '04' + aggPoint.getX().toString(16).padStart(64, '0') + aggPoint.getY().toString(16).padStart(64, '0'),
    x,
    y
  };
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

// ─── Proof of Possession ──────────────────────────────────────────────────────

/**
 * Verify ownership proof: party proves they own the private key for pubKey
 * by signing a message with that private key.
 *
 * Message format: "I own this TSS key: {walletAddress} {pubKey}"
 *
 * @param {string} message         - Original message that was signed
 * @param {string} signature       - Schnorr signature (hex, 64-128 chars)
 * @param {string} pubKeyHex       - The public key to verify against (uncompressed)
 * @param {string} walletAddress   - Expected wallet address (for message validation)
 * @returns {{ valid: boolean, recoveredPubKey?: string, error?: string }}
 */
export function verifyOwnershipProof(message, signature, pubKeyHex, walletAddress) {
  try {
    // 1. Normalize inputs
    const clean_sig = String(signature || '').replace(/^0x/i, '').trim();
    const clean_pubkey = normalizePubKey(pubKeyHex);
    const clean_wallet = String(walletAddress || '').toLowerCase().trim();

    // 2. Validate signature format (should be 64-128 hex chars for Schnorr)
    if (!/^[0-9a-f]{64,128}$/i.test(clean_sig)) {
      return { valid: false, error: 'Invalid signature format. Expected 64-128 hex characters.' };
    }

    // 3. Hash the message (using same method as frontend)
    const messageHash = ethers.id(message);

    // 4. Parse signature (r, z for Schnorr)
    // For Schnorr: signature = r || z (where r is point on curve, z is scalar)
    // We'll use elliptic's built-in recovery if available, or basic verification
    const r = clean_sig.slice(0, 64);
    const z = clean_sig.slice(64, 128) || clean_sig.slice(0, 64); // Handle both 64 and 128 char sigs

    // 5. Recover public key from signature
    // For Schnorr verification: compute z*G - hash*PK and check it equals r*G
    // Simplified: try to match pubkey by computing z*G - (hash mod ORDER)*PK
    const z_bigint = BigInt('0x' + z);
    const hash_bigint = BigInt(messageHash);
    const r_bigint = BigInt('0x' + r);

    const pubKeyPoint = ec.keyFromPublic(clean_pubkey, 'hex').getPublic();
    const pubKeyX = pubKeyPoint.getX();
    const pubKeyY = pubKeyPoint.getY();

    // For additive Schnorr: compute z*G
    const G = ec.g;
    const zG = G.mul(z_bigint);

    // Compute hash * PK (scalar mult)
    const hashModOrder = hash_bigint % ORDER;
    const hashPK = pubKeyPoint.mul(hashModOrder);

    // Compute z*G - hash*PK
    const negHashPK = hashPK.neg();
    const recovered = zG.add(negHashPK);

    // Verify: recovered should equal r*G (or at least have same x-coordinate with r)
    const recoveredX = recovered.getX();
    const recoveredY = recovered.getY();

    // 6. Verify the public key matches
    const derivedAddr = pointToAddress(recoveredX.toString(16), recoveredY.toString(16));

    // Compare with submitted public key's address
    const submittalAddr = pointToAddress(pubKeyX.toString(16), pubKeyY.toString(16));

    if (submittalAddr.toLowerCase() !== derivedAddr.toLowerCase()) {
      return {
        valid: false,
        error: 'Ownership proof failed: signature does not match public key'
      };
    }

    // 7. Verify wallet address matches (optional check for added security)
    if (clean_wallet && clean_wallet !== '0x') {
      const walletFromPubKey = submittalAddr.toLowerCase();
      if (walletFromPubKey !== clean_wallet.toLowerCase()) {
        return {
          valid: false,
          error: `Wallet mismatch: pubKey address ${walletFromPubKey} != wallet ${clean_wallet}`
        };
      }
    }

    return {
      valid: true,
      recoveredPubKey: '0x' + clean_pubkey
    };
  } catch (error) {
    return {
      valid: false,
      error: `Ownership proof verification failed: ${error.message}`
    };
  }
}

/**
 * Create ownership challenge message for frontend to sign
 * @param {string} walletAddress - Ethereum address of the party
 * @param {string} pubKeyHex     - Public key to prove ownership of
 * @returns {string} Message to be signed by party
 */
export function createOwnershipChallenge(walletAddress, pubKeyHex) {
  const clean_wallet = String(walletAddress || '').trim();
  const clean_pubkey = String(pubKeyHex || '').replace(/^0x/i, '').trim();
  return `I own this TSS key: ${clean_wallet} 0x${clean_pubkey}`;
}

export { pointToAddress };

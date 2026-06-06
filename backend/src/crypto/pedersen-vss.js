/**
 * Pedersen Verifiable Secret Sharing (VSS) cho DKG phân tán 5-of-7
 *
 * Mỗi party i:
 *   1. Sinh polynomial bậc t-1=4: fᵢ(x) = aᵢ₀ + aᵢ₁x + ... + aᵢ₄x⁴
 *   2. Broadcast Feldman commitments: Cᵢⱼ = aᵢⱼ * G  (j = 0..4)
 *   3. Gửi share đóng góp cho party j: sᵢⱼ = fᵢ(ROLE_TO_ID[j])
 *   4. Party j verify: sᵢⱼ * G == Σₖ Cᵢₖ * j_id^k
 *   5. Party j tổng hợp: sⱼ = Σᵢ sᵢⱼ  →  Pⱼ = sⱼ * G
 *
 * Master public key: P = Σᵢ Cᵢ₀  (không cần biết master secret)
 * Tính nhất quán: Σ_{j∈S} λⱼ(S) * Pⱼ = P  với mọi valid 5-subset S
 */

import EC_Module from 'elliptic';
import { randomBytes } from 'crypto';

const ec = new EC_Module.ec('secp256k1');
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// Threshold: bất kỳ 5-of-7 party đều có thể ký
const THRESHOLD = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomScalar() {
  // Sinh scalar ngẫu nhiên an toàn trong [1, ORDER-1]
  let scalar;
  do {
    const bytes = randomBytes(32);
    scalar = BigInt('0x' + bytes.toString('hex'));
  } while (scalar === 0n || scalar >= ORDER);
  return scalar;
}

function scalarToHex(scalar) {
  return '0x' + scalar.toString(16).padStart(64, '0');
}

function hexToScalar(hex) {
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

// Nhân điểm EC bởi scalar BigInt
function pointMul(point, scalar) {
  const s = ((scalar % ORDER) + ORDER) % ORDER;
  return point.mul(s.toString(16));
}

// Chuyển EC point sang { x, y } hex strings
function pointToCoords(point) {
  return {
    x: '0x' + point.getX().toString(16).padStart(64, '0'),
    y: '0x' + point.getY().toString(16).padStart(64, '0'),
  };
}

// Khôi phục EC point từ { x, y }
function coordsToPoint(coords) {
  const x = coords.x.replace(/^0x/i, '').padStart(64, '0');
  const y = coords.y.replace(/^0x/i, '').padStart(64, '0');
  return ec.keyFromPublic('04' + x + y, 'hex').getPublic();
}

// ─── Core VSS Functions ────────────────────────────────────────────────────────

/**
 * Sinh polynomial bậc (THRESHOLD-1) với t hệ số ngẫu nhiên.
 * fᵢ(x) = coeffs[0] + coeffs[1]*x + ... + coeffs[t-1]*x^(t-1)
 *
 * @returns {{ coeffs: string[] }}  mảng THRESHOLD scalars (hex), coeffs[0] = hệ số tự do a₀
 */
export function generatePolynomial() {
  const coeffs = [];
  for (let j = 0; j < THRESHOLD; j++) {
    coeffs.push(scalarToHex(randomScalar()));
  }
  return { coeffs };
}

/**
 * Tính Feldman commitments từ polynomial: Cⱼ = coeffs[j] * G
 *
 * @param {string[]} coeffs  - mảng THRESHOLD scalars (hex)
 * @returns {{ x: string, y: string }[]}  mảng THRESHOLD EC points
 */
export function computeCommitments(coeffs) {
  const G = ec.g;
  return coeffs.map(coeff => {
    const scalar = hexToScalar(coeff);
    const point = pointMul(G, scalar);
    return pointToCoords(point);
  });
}

/**
 * Tính share đóng góp của party i cho party j: sᵢⱼ = fᵢ(participantId)
 *
 * @param {string[]} coeffs        - polynomial của party i
 * @param {number}   participantId - ROLE_TO_ID[role_j] (1..7)
 * @returns {string}  scalar hex (share)
 */
export function evaluatePolynomial(coeffs, participantId) {
  const x = BigInt(participantId);
  let result = 0n;
  let xPow = 1n;  // x^0 = 1
  for (const coeff of coeffs) {
    result = (result + hexToScalar(coeff) * xPow) % ORDER;
    xPow = (xPow * x) % ORDER;
  }
  return scalarToHex(result);
}

/**
 * Feldman verification: kiểm tra sᵢⱼ * G == Σₖ Cᵢₖ * j_id^k
 * Party j dùng để xác minh share nhận từ party i là hợp lệ.
 *
 * @param {string}               shareHex       - sᵢⱼ (hex)
 * @param {{ x, y }[]}           commitments    - Feldman commitments của party i
 * @param {number}               participantId  - ROLE_TO_ID[role_j]
 * @returns {boolean}
 */
export function verifyShare(shareHex, commitments, participantId) {
  if (!commitments || commitments.length !== THRESHOLD) return false;

  const G = ec.g;
  const share = hexToScalar(shareHex);
  const x = BigInt(participantId);

  // Tính share * G
  const sharePoint = pointMul(G, share);

  // Tính Σₖ Cᵢₖ * j_id^k
  let expectedPoint = null;
  let xPow = 1n; // x^0 = 1
  for (const commitment of commitments) {
    const Cik = coordsToPoint(commitment);
    const term = pointMul(Cik, xPow);
    expectedPoint = expectedPoint ? expectedPoint.add(term) : term;
    xPow = (xPow * x) % ORDER;
  }

  if (!expectedPoint) return false;

  const sp = pointToCoords(sharePoint);
  const ep = pointToCoords(expectedPoint);
  return sp.x.toLowerCase() === ep.x.toLowerCase() &&
         sp.y.toLowerCase() === ep.y.toLowerCase();
}

/**
 * Tổng hợp tất cả shares nhận được thành final signing share.
 * sⱼ = Σᵢ sᵢⱼ  (mod ORDER)
 *
 * @param {string[]} shares - mảng scalar hex từ tất cả parties
 * @returns {string}  final private share (hex)
 */
export function aggregateShares(shares) {
  const sum = shares.reduce((acc, s) => (acc + hexToScalar(s)) % ORDER, 0n);
  return scalarToHex(sum);
}

/**
 * Tính final public key của party j từ final signing share.
 * Pⱼ = sⱼ * G
 *
 * @param {string} finalShareHex - kết quả từ aggregateShares
 * @returns {{ x: string, y: string }}
 */
export function computeSigningPublicKey(finalShareHex) {
  const G = ec.g;
  const scalar = hexToScalar(finalShareHex);
  const point = pointMul(G, scalar);
  return pointToCoords(point);
}

/**
 * Tính master public key từ tất cả constant-term commitments.
 * P = Σᵢ Cᵢ₀  (không cần biết master secret)
 *
 * Party nào cũng có thể tính, dùng để deploy vault.
 *
 * @param {{ x: string, y: string }[][]} allCommitments - mảng commitments của tất cả 7 parties
 * @returns {{ x: string, y: string }}
 */
export function computeMasterPublicKey(allCommitments) {
  let masterPoint = null;
  for (const commitments of allCommitments) {
    // Chỉ dùng constant term Cᵢ₀ (index 0)
    const C0 = coordsToPoint(commitments[0]);
    masterPoint = masterPoint ? masterPoint.add(C0) : C0;
  }
  if (!masterPoint) throw new Error('No commitments provided');
  return pointToCoords(masterPoint);
}

/**
 * Tính signing public key Pⱼ của party j HOÀN TOÀN từ Feldman commitments công khai.
 * KHÔNG cần secret, KHÔNG cần shares.
 *
 *   Pⱼ = sⱼ·G = (Σᵢ fᵢ(j))·G = Σᵢ Σₖ Cᵢₖ · jᵏ
 *
 * Cho phép backend suy ra signing pubkey của mọi party ngay khi đủ commitments,
 * không phụ thuộc party có hoàn thành bước aggregate hay không.
 *
 * @param {{ x: string, y: string }[][]} allCommitments - commitments của tất cả parties (mỗi party THRESHOLD points)
 * @param {number}                       participantId  - ROLE_TO_ID[role_j] (1..7)
 * @returns {{ x: string, y: string }}   Pⱼ
 */
export function computeSigningPublicKeyFromCommitments(allCommitments, participantId) {
  const x = BigInt(participantId);
  let total = null;

  for (const commitments of allCommitments) {
    if (!commitments || commitments.length !== THRESHOLD) {
      throw new Error(`Mỗi party phải có ${THRESHOLD} commitments`);
    }
    // Σₖ Cᵢₖ · jᵏ  (đóng góp của party i vào Pⱼ)
    let partyContribution = null;
    let xPow = 1n; // j^0
    for (const commitment of commitments) {
      const Cik = coordsToPoint(commitment);
      const term = pointMul(Cik, xPow);
      partyContribution = partyContribution ? partyContribution.add(term) : term;
      xPow = (xPow * x) % ORDER;
    }
    total = total ? total.add(partyContribution) : partyContribution;
  }

  if (!total) throw new Error('No commitments provided');
  return pointToCoords(total);
}

/**
 * Kiểm tra master public key có nhất quán với final signing keys không.
 * P == Σ_{j∈S} λⱼ(S) * Pⱼ  với mọi valid 5-subset
 *
 * @param {{ x, y }}                     masterPubKey
 * @param {{ role: { x, y } }}           signingPubKeys  - map role → Pⱼ
 * @param {number[]}                     participantIds  - subset IDs để test
 * @param {import('./dkg.js').ROLE_TO_ID} roleToId
 * @returns {boolean}
 */
export function verifyMasterKeyConsistency(masterPubKey, signingPubKeys, participantIds, roleToId) {
  // Tính Lagrange coefficients cho subset
  const ids = participantIds;
  const coeffs = {};
  for (const xi of ids) {
    let num = 1n;
    let den = 1n;
    for (const xj of ids) {
      if (xi === xj) continue;
      num = (num * (0n - BigInt(xj))) % ORDER;
      den = (den * (BigInt(xi) - BigInt(xj))) % ORDER;
    }
    const inv = modInverse(den, ORDER);
    coeffs[xi] = ((num * inv) % ORDER + ORDER) % ORDER;
  }

  // Tổng hợp Σ λⱼ * Pⱼ
  const roles = Object.keys(signingPubKeys);
  let aggPoint = null;
  for (const [role, pubKey] of Object.entries(signingPubKeys)) {
    const id = roleToId[role];
    if (!participantIds.includes(id)) continue;
    const lambda = coeffs[id];
    const P = coordsToPoint(pubKey);
    const term = pointMul(P, lambda);
    aggPoint = aggPoint ? aggPoint.add(term) : term;
  }

  if (!aggPoint) return false;
  const agg = pointToCoords(aggPoint);
  const master = {
    x: '0x' + BigInt(masterPubKey.x).toString(16).padStart(64, '0'),
    y: '0x' + BigInt(masterPubKey.y).toString(16).padStart(64, '0'),
  };
  return agg.x.toLowerCase() === master.x.toLowerCase() &&
         agg.y.toLowerCase() === master.y.toLowerCase();
}

// modInverse cục bộ (tránh import vòng)
function modInverse(a, m) {
  a = ((a % m) + m) % m;
  if (a === 0n) throw new Error('Modular inverse does not exist');
  let m0 = m, x0 = 0n, x1 = 1n;
  while (a > 1n) {
    const q = a / m;
    let t = m; m = a % m; a = t;
    t = x0; x0 = x1 - q * x0; x1 = t;
  }
  if (x1 < 0n) x1 += m0;
  return x1;
}

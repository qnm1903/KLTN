import crypto from 'crypto';

/**
 * Calculate SHA-256 hash of a string
 * @param {string} data - String to hash
 * @returns {string} Hex string of hash
 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Calculate Merkle root from array of hashes
 * @param {string[]} hashes - Array of hex hashes
 * @returns {string} Merkle root (hex string)
 */
export function calculateMerkleRoot(hashes) {
  if (!hashes || hashes.length === 0) {
    return '0x' + sha256('');
  }

  if (hashes.length === 1) {
    return hashes[0].startsWith('0x') ? hashes[0] : '0x' + hashes[0];
  }

  let currentLevel = hashes.map(h => h.startsWith('0x') ? h.slice(2) : h);

  while (currentLevel.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left; // If odd number, duplicate last
      const combined = left + right;
      nextLevel.push(sha256(combined));
    }
    currentLevel = nextLevel;
  }

  return '0x' + currentLevel[0];
}

/**
 * Get Merkle proof for a specific hash
 * @param {string} targetHash - Hash to get proof for
 * @param {string[]} hashes - All hashes in the tree
 * @returns {string[]} Array of sibling hashes
 */
export function getMerkleProof(targetHash, hashes) {
  if (!hashes || hashes.length === 0) return [];

  const target = targetHash.startsWith('0x') ? targetHash.slice(2) : targetHash;
  let currentLevel = hashes.map(h => h.startsWith('0x') ? h.slice(2) : h);
  const proof = [];

  while (currentLevel.length > 1) {
    const index = currentLevel.indexOf(target);
    if (index === -1) return []; // Target not found

    const isLeft = index % 2 === 0;
    const siblingIndex = isLeft ? index + 1 : index - 1;
    const sibling = currentLevel[siblingIndex] || currentLevel[index]; // Handle odd number

    proof.push('0x' + sibling);

    // Calculate parent hash
    const left = currentLevel[index];
    const right = currentLevel[siblingIndex] || left;
    const combined = left + right;
    const parent = sha256(combined);

    // Build next level
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const l = currentLevel[i];
      const r = currentLevel[i + 1] || l;
      const c = l + r;
      nextLevel.push(sha256(c));
    }
    currentLevel = nextLevel;
  }

  return proof;
}

/**
 * Verify Merkle proof
 * @param {string} targetHash - Hash to verify
 * @param {string[]} proof - Merkle proof
 * @param {string} root - Merkle root
 * @returns {boolean} True if valid
 */
export function verifyMerkleProof(targetHash, proof, root) {
  if (!proof || proof.length === 0) {
    return targetHash === root;
  }

  let current = targetHash.startsWith('0x') ? targetHash.slice(2) : targetHash;
  const rootHash = root.startsWith('0x') ? root.slice(2) : root;

  for (const sibling of proof) {
    const sib = sibling.startsWith('0x') ? sibling.slice(2) : sibling;
    const combined = current + sib;
    current = sha256(combined);
  }

  return current === rootHash;
}
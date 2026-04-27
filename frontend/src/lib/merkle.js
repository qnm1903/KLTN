import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import { Buffer } from 'buffer';

/**
 * Hash file content using SHA-256
 * @param {File} file - File object to hash
 * @returns {Promise<string>} Hex string of hash
 */
export async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hashHex;
}

/**
 * Hash string using keccak256
 * @param {string} data - String to hash
 * @returns {Buffer} Hash buffer
 */
export function hashString(data) {
  return Buffer.from(keccak256(data).toString('hex'), 'hex');
}

/**
 * Build Merkle tree from file hashes
 * @param {string[]} fileHashes - Array of file hashes (hex strings)
 * @returns {MerkleTree} Merkle tree instance
 */
export function buildMerkleTree(fileHashes) {
  const leaves = fileHashes.map(hash => hashString(hash));
  return new MerkleTree(leaves, keccak256, { sortPairs: true });
}

/**
 * Get Merkle root from file hashes
 * @param {string[]} fileHashes - Array of file hashes
 * @returns {string} Merkle root (hex string)
 */
export function getMerkleRoot(fileHashes) {
  const tree = buildMerkleTree(fileHashes);
  return '0x' + tree.getRoot().toString('hex');
}

/**
 * Get Merkle proof for a specific file
 * @param {string} fileHash - Hash of the file
 * @param {string[]} fileHashes - All file hashes
 * @returns {string[]} Merkle proof
 */
export function getMerkleProof(fileHash, fileHashes) {
  const tree = buildMerkleTree(fileHashes);
  const leaf = hashString(fileHash);
  const proof = tree.getProof(leaf);
  return proof.map(p => '0x' + p.data.toString('hex'));
}

/**
 * Verify Merkle proof
 * @param {string} fileHash - Hash of the file
 * @param {string[]} proof - Merkle proof
 * @param {string} root - Merkle root
 * @returns {boolean} True if valid
 */
export function verifyMerkleProof(fileHash, proof, root) {
  const tree = buildMerkleTree([fileHash]);
  const leaf = hashString(fileHash);
  const proofBuffers = proof.map(p => Buffer.from(p.slice(2), 'hex'));
  const rootBuffer = Buffer.from(root.slice(2), 'hex');
  return tree.verify(proofBuffers, leaf, rootBuffer);
}
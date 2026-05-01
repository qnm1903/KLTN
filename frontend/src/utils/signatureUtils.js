export const DISPUTE_DOMAIN = {
  name: 'DisputeEscrow',
  version: '1',
  // chainId và verifyingContract thường được set khi gọi sign function
  // Ex: { name: 'DisputeEscrow', version: '1', chainId: 1, verifyingContract: '0x...' }
};

/**
 * EIP-712 types cho Vote payload
 * Vote {
 *   mediator: address,
 *   vote: string,
 *   justification: string,
 *   evidenceRefs: string[],
 *   timestamp: string
 * }
 */
export const VOTE_TYPES = {
  Vote: [
    { name: 'mediator', type: 'address' },
    { name: 'vote', type: 'string' },
    { name: 'justification', type: 'string' },
    { name: 'evidenceRefs', type: 'string[]' },
    { name: 'timestamp', type: 'string' }
  ]
};

/**
 * EIP-712 types cho Evidence metadata
 * EvidenceMeta {
 *   ipfsHash: string,
 *   disputeId: string,
 *   uploader: address,
 *   timestamp: string
 * }
 */
export const EVIDENCE_TYPES = {
  EvidenceMeta: [
    { name: 'ipfsHash', type: 'string' },
    { name: 'disputeId', type: 'string' },
    { name: 'uploader', type: 'address' },
    { name: 'timestamp', type: 'string' }
  ]
};

async function _resolveChainId(walletClient, fallback = 1) {
  try {
    if (walletClient && typeof walletClient.getChainId === 'function') {
      const cid = await walletClient.getChainId();
      if (cid) return cid;
    }
  } catch {
    // ignore
  }
  return fallback;
}

/**
 * signVotePayload
 *
 * Tạo EIP-712 signature cho Vote payload bằng viem WalletClient.signTypedData.
 *
 * @param {import('viem').WalletClient} walletClient - instance WalletClient (from viem)
 * @param {string} account - address của signer (mediator)
 * @param {string} mediatorAddress - mediator address (should match account)
 * @param {Object} voteData - { vote, justification, evidenceRefs, timestamp, disputeId?, verifyingContract?, chainId? }
 * @returns {Promise<string>} signature hex (0x...)
 *
 * Ví dụ voteData:
 * {
 *   vote: 'RELEASE_TO_BUYER',
 *   justification: 'Reason...',
 *   evidenceRefs: ['ipfs://Q...'],
 *   timestamp: '2026-05-01T12:00:00.000Z',
 *   verifyingContract: '0xContract',
 *   chainId: 1
 * }
 */
export async function signVotePayload(walletClient, account, mediatorAddress, voteData) {
  if (!walletClient || !account || !mediatorAddress || !voteData) {
    throw new Error('walletClient, account, mediatorAddress và voteData là bắt buộc');
  }

  const chainId = voteData.chainId || (await _resolveChainId(walletClient, 1));
  const verifyingContract = voteData.verifyingContract || voteData.disputeContract || null;

  const domain = {
    name: DISPUTE_DOMAIN.name,
    version: DISPUTE_DOMAIN.version,
    chainId,
    verifyingContract: verifyingContract || undefined
  };

  const message = {
    mediator: mediatorAddress,
    vote: voteData.vote,
    justification: voteData.justification || '',
    evidenceRefs: Array.isArray(voteData.evidenceRefs) ? voteData.evidenceRefs : [],
    timestamp: voteData.timestamp || new Date().toISOString()
  };

  // viem WalletClient.signTypedData expects { domain, types, primaryType, message, account }
  try {
    const signature = await walletClient.signTypedData({
      domain,
      types: VOTE_TYPES,
      primaryType: 'Vote',
      message,
      account
    });
    return signature;
  } catch (err) {
    // Forward error with helpful message
    throw new Error(`signVotePayload failed: ${err?.message || err}`);
  }
}

/**
 * signEvidenceMetadata
 *
 * Sign Evidence metadata (ipfsHash + disputeId + uploader + timestamp) using EIP-712.
 *
 * @param {import('viem').WalletClient} walletClient - viem WalletClient instance
 * @param {string} account - address of signer (uploader)
 * @param {Object} metadata - { ipfsHash, disputeId, timestamp?, verifyingContract?, chainId? }
 * @returns {Promise<string>} signature hex (0x...)
 *
 * Example metadata:
 * { ipfsHash: 'ipfs://Q...', disputeId: 'uuid', timestamp: '2026-05-01T12:00:00Z' }
 */
export async function signEvidenceMetadata(walletClient, account, metadata) {
  if (!walletClient || !account || !metadata || !metadata.ipfsHash || !metadata.disputeId) {
    throw new Error('walletClient, account, metadata(ipfsHash, disputeId) là bắt buộc');
  }

  const chainId = metadata.chainId || (await _resolveChainId(walletClient, 1));
  const verifyingContract = metadata.verifyingContract || null;

  const domain = {
    name: DISPUTE_DOMAIN.name,
    version: DISPUTE_DOMAIN.version,
    chainId,
    verifyingContract: verifyingContract || undefined
  };

  const message = {
    ipfsHash: metadata.ipfsHash,
    disputeId: metadata.disputeId,
    uploader: account,
    timestamp: metadata.timestamp || new Date().toISOString()
  };

  try {
    const signature = await walletClient.signTypedData({
      domain,
      types: EVIDENCE_TYPES,
      primaryType: 'EvidenceMeta',
      message,
      account
    });
    return signature;
  } catch (err) {
    throw new Error(`signEvidenceMetadata failed: ${err?.message || err}`);
  }
}

export default {
  DISPUTE_DOMAIN,
  VOTE_TYPES,
  EVIDENCE_TYPES,
  signVotePayload,
  signEvidenceMetadata
};
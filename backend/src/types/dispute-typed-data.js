export const DISPUTE_DOMAIN = {
  name: 'KLTNDisputeVoting',
  version: '1',
  chainId: 11155111,
  verifyingContract: '0x0000000000000000000000000000000000000000'
};

export const VOTE_TYPE = {
  Vote: [
    { name: 'disputeId', type: 'string' },
    { name: 'escrowId', type: 'string' },
    { name: 'mediatorsHash', type: 'bytes32' },
    { name: 'vote', type: 'string' },
    { name: 'justificationHash', type: 'bytes32' },
    { name: 'evidenceRoot', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

export const ACCEPT_MEDIATOR_TYPE = {
  AcceptMediator: [
    { name: 'disputeId', type: 'string' },
    { name: 'escrowId', type: 'string' },
    { name: 'mediator', type: 'address' },
    { name: 'decision', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

export const EVIDENCE_META_TYPE = {
  EvidenceMeta: [
    { name: 'disputeId', type: 'string' },
    { name: 'escrowId', type: 'string' },
    { name: 'evidenceId', type: 'string' },
    { name: 'fileHash', type: 'bytes32' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

export function buildDisputeDomain(overrides = {}) {
  const chainId = Number(overrides.chainId ?? process.env.CHAIN_ID ?? DISPUTE_DOMAIN.chainId);
  const verifyingContract =
    overrides.verifyingContract ??
    process.env.EIP712_VERIFYING_CONTRACT ??
    DISPUTE_DOMAIN.verifyingContract;

  return {
    ...DISPUTE_DOMAIN,
    ...overrides,
    chainId,
    verifyingContract
  };
}
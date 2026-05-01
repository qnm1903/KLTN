import {
  DISPUTE_STATUS,
  MEDIATOR_STATUS,
  VOTE_CHOICE,
  DISPUTE_THRESHOLD
} from '../src/constants/dispute.constants.js';

/**
 * Một số địa chỉ ví giả (checksum-like)
 * (lưu ý: chỉ dùng cho mock data, không phải địa chỉ thực)
 */
const ADDR_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const ADDR_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const ADDR_C = '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc';
const ADDR_D = '0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd';
const ADDR_E = '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe';
const ADDR_F = '0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf';
const ADDR_G = '0xc3104EC2E70B577bCB980052afBb1deE9C66f523';
const INITIATOR = '0x1234567890abcdef1234567890abcdef12345678';

/**
 * Mock Evidence array (tuân theo typedef Evidence)
 * @type {Array<import('../src/constants/dispute.constants.js').Evidence>}
 */
export const mockEvidenceList = [
  {
    id: 'e1',
    ipfsHash: 'ipfs://QmExampleHash1',
    uploader: INITIATOR,
    description: 'Screenshot: payment confirmation',
    metadata: { mime: 'image/png', size: 24567, name: 'payment.png' },
    uploadedAt: '2026-04-29T10:15:00.000Z',
    confidential: false,
    signature: '0xSigExample1',
    merkleLeafHash: null
  },
  {
    id: 'e2',
    ipfsHash: 'ipfs://QmExampleHash2',
    uploader: ADDR_B,
    description: 'Contract screenshot showing disputed terms',
    metadata: { mime: 'image/jpeg', size: 98765, name: 'terms.jpg' },
    uploadedAt: '2026-04-29T11:00:00.000Z',
    confidential: true,
    signature: '0xSigExample2',
    merkleLeafHash: null
  },
  {
    id: 'e3',
    ipfsHash: 'ipfs://QmExampleHash3',
    uploader: ADDR_C,
    description: 'Chat log excerpt',
    metadata: { mime: 'text/plain', size: 2048, name: 'chat.txt' },
    uploadedAt: '2026-04-29T11:30:00.000Z',
    confidential: false,
    signature: null,
    merkleLeafHash: null
  }
];

/**
 * Mock Mediators (7) với trạng thái hỗn hợp
 * @type {Array<import('../src/constants/dispute.constants.js').Mediator>}
 */
export const mockMediators = [
  {
    address: ADDR_A,
    status: MEDIATOR_STATUS.ACCEPTED,
    acceptedAt: '2026-04-29T12:00:00.000Z',
    declinedAt: null,
    votedAt: '2026-04-30T08:00:00.000Z',
    voteChoice: VOTE_CHOICE.RELEASE_TO_BUYER,
    score: 92,
    note: null
  },
  {
    address: ADDR_B,
    status: MEDIATOR_STATUS.ACCEPTED,
    acceptedAt: '2026-04-29T12:05:00.000Z',
    declinedAt: null,
    votedAt: '2026-04-30T08:05:00.000Z',
    voteChoice: VOTE_CHOICE.RELEASE_TO_BUYER,
    score: 88,
    note: null
  },
  {
    address: ADDR_C,
    status: MEDIATOR_STATUS.ACCEPTED,
    acceptedAt: '2026-04-29T12:10:00.000Z',
    declinedAt: null,
    votedAt: '2026-04-30T08:10:00.000Z',
    voteChoice: VOTE_CHOICE.RETURN_TO_SELLER,
    score: 75,
    note: null
  },
  {
    address: ADDR_D,
    status: MEDIATOR_STATUS.VOTED,
    acceptedAt: '2026-04-29T12:12:00.000Z',
    declinedAt: null,
    votedAt: '2026-04-30T08:12:00.000Z',
    voteChoice: VOTE_CHOICE.RELEASE_TO_BUYER,
    score: 80,
    note: null
  },
  {
    address: ADDR_E,
    status: MEDIATOR_STATUS.NO_RESPONSE,
    acceptedAt: null,
    declinedAt: null,
    votedAt: null,
    voteChoice: null,
    score: 60,
    note: null
  },
  {
    address: ADDR_F,
    status: MEDIATOR_STATUS.DECLINED,
    acceptedAt: null,
    declinedAt: '2026-04-29T13:00:00.000Z',
    votedAt: null,
    voteChoice: null,
    score: 40,
    note: 'User declined due to conflict of interest'
  },
  {
    address: ADDR_G,
    status: MEDIATOR_STATUS.ASSIGNED,
    acceptedAt: null,
    declinedAt: null,
    votedAt: null,
    voteChoice: null,
    score: 50,
    note: null
  }
];

/**
 * Mock VoteTally tương ứng (3 RELEASE_TO_BUYER, 1 RETURN_TO_SELLER)
 * @type {import('../src/constants/dispute.constants.js').VoteTally}
 */
export const mockVoteTally = {
  RELEASE_TO_BUYER: 3,
  RETURN_TO_SELLER: 1,
  SPLIT: 0,
  OTHER: 0,
  totalVotes: 4,
  threshold: DISPUTE_THRESHOLD
};

/**
 * Mock Votes array (detail)
 * @type {Array<import('../src/constants/dispute.constants.js').Vote>}
 */
export const mockVotes = [
  {
    mediator: ADDR_A,
    vote: VOTE_CHOICE.RELEASE_TO_BUYER,
    justification: 'Payment confirmed; seller did not deliver digital goods',
    evidenceRefs: ['e1'],
    timestamp: '2026-04-30T08:00:00.000Z',
    signature: '0xVoteSigA'
  },
  {
    mediator: ADDR_B,
    vote: VOTE_CHOICE.RELEASE_TO_BUYER,
    justification: 'Agrees with evidence and timeline',
    evidenceRefs: ['e1', 'e3'],
    timestamp: '2026-04-30T08:05:00.000Z',
    signature: '0xVoteSigB'
  },
  {
    mediator: ADDR_C,
    vote: VOTE_CHOICE.RETURN_TO_SELLER,
    justification: 'Contract clause favors seller',
    evidenceRefs: ['e2'],
    timestamp: '2026-04-30T08:10:00.000Z',
    signature: '0xVoteSigC'
  },
  {
    mediator: ADDR_D,
    vote: VOTE_CHOICE.RELEASE_TO_BUYER,
    justification: 'Minority but persuasive evidence for buyer',
    evidenceRefs: ['e1'],
    timestamp: '2026-04-30T08:12:00.000Z',
    signature: '0xVoteSigD'
  }
];

/**
 * Mock detailed Dispute object
 * @type {import('../src/constants/dispute.constants.js').Dispute}
 */
export const mockDisputeDetail = {
  disputeId: '550e8400-e29b-41d4-a716-446655440000',
  escrowId: 'escrow-1234',
  status: DISPUTE_STATUS.VOTING,
  initiatorAddress: INITIATOR,
  mediators: mockMediators,
  evidence: mockEvidenceList,
  createdAt: '2026-04-29T10:00:00.000Z',
  assignedAt: '2026-04-29T12:00:00.000Z',
  finalizedAt: null,
  outcome: null,
  onChain: {
    disputeContract: '0xContractAddressExample',
    disputeIndex: 42,
    events: [
      {
        name: 'DisputeInitiated',
        txHash: '0xTxHashInit',
        blockNumber: 123456,
        timestamp: '2026-04-29T10:01:00.000Z'
      },
      {
        name: 'MediatorsSelected',
        txHash: '0xTxHashVRF',
        blockNumber: 123460,
        timestamp: '2026-04-29T12:00:10.000Z'
      }
    ]
  },
  requestId: 'vrf-request-abc-123',
  onChainTxHash: '0xTxHashInit',
  evidenceMerkleRoot: null
};

/**
 * Mock dispute list (summary) - dùng cho Dispute List page
 * @type {Array<Partial<import('../src/constants/dispute.constants.js').Dispute>>}
 */
export const mockDisputeList = [
  {
    disputeId: '550e8400-e29b-41d4-a716-446655440000',
    escrowId: 'escrow-1234',
    status: DISPUTE_STATUS.VOTING,
    createdAt: '2026-04-29T10:00:00.000Z',
    initiatorAddress: INITIATOR,
    onChainTxHash: '0xTxHashInit'
  },
  {
    disputeId: '660e8400-e29b-41d4-a716-446655440001',
    escrowId: 'escrow-5678',
    status: DISPUTE_STATUS.PENDING_VRF,
    createdAt: '2026-04-29T09:40:00.000Z',
    initiatorAddress: ADDR_B,
    onChainTxHash: null
  },
  {
    disputeId: '770e8400-e29b-41d4-a716-446655440002',
    escrowId: 'escrow-9999',
    status: DISPUTE_STATUS.RESOLVED,
    createdAt: '2026-04-27T14:22:00.000Z',
    initiatorAddress: ADDR_C,
    onChainTxHash: '0xTxHashResolved'
  }
];

/**
 * Mock WebSocket payloads (ví dụ) - tuân theo typedefs
 */
export const mockWSEvidenceAdded = {
  disputeId: mockDisputeDetail.disputeId,
  evidence: mockEvidenceList[0]
};

export const mockWSVoteProgress = {
  disputeId: mockDisputeDetail.disputeId,
  tally: mockVoteTally,
  totalVotes: mockVoteTally.totalVotes,
  threshold: mockVoteTally.threshold
};

/**
 * Default export giúp import nhanh trong test
 */
export default {
  mockEvidenceList,
  mockMediators,
  mockVoteTally,
  mockVotes,
  mockDisputeDetail,
  mockDisputeList,
  mockWSEvidenceAdded,
  mockWSVoteProgress
};
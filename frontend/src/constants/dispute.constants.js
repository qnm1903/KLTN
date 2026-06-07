/**
 * DISPUTE STATUS Enum-like constant
 * @readonly
 * @enum {string}
 */
export const DISPUTE_STATUS = {
  PENDING_VRF: 'PENDING_VRF',
  MEDIATORS_ASSIGNED: 'MEDIATORS_ASSIGNED',
  MEDIATORS_ASSIGNED_PENDING_ACCEPTANCE: 'MEDIATORS_ASSIGNED_PENDING_ACCEPTANCE',
  VOTING: 'VOTING',
  RESOLVED: 'RESOLVED',
  VRF_FAILED: 'VRF_FAILED',
  APPEAL_WINDOW: 'APPEAL_WINDOW',
  TIMED_OUT: 'TIMED_OUT'
};

/**
 * MEDIATOR STATUS Enum-like constant
 * @readonly
 * @enum {string}
 */
export const MEDIATOR_STATUS = {
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  VOTED: 'voted',
  NO_RESPONSE: 'no_response'
};

/**
 * VOTE CHOICE Enum-like constant
 * @readonly
 * @enum {string}
 */
// Action-aligned vote choices:
//   RELEASE = release() = funds to seller
//   REFUND  = refund()  = funds to buyer
//   SPLIT   = 50/50, auto-derived on a 3-2 deadlock (not a manual choice)
export const VOTE_CHOICE = {
  RELEASE: 'RELEASE',
  REFUND: 'REFUND',
  SPLIT: 'SPLIT',
  OTHER: 'OTHER'
};

/**
 * Số phiếu cùng một phe cần để quyết định (4/5). 3-2 → SPLIT.
 * @constant {number}
 */
export const DISPUTE_THRESHOLD = 4;

/**
 * @typedef {Object} FileMetadata
 * @property {string} mime MIME type của file (ví dụ "image/png")
 * @property {number} size Kích thước file tính bằng bytes
 * @property {string} [name] Tên file gốc (tuỳ chọn)
 */

/**
 * @typedef {Object} Evidence
 * @property {string} id Internal id cho Evidence (ví dụ "e1")
 * @property {string} ipfsHash IPFS URI (ví dụ "ipfs://Q...")
 * @property {string} uploader Wallet address (checksum-format)
 * @property {string} [description] Mô tả ngắn
 * @property {FileMetadata} [metadata] Thông tin file off-chain (mime, size)
 * @property {string} uploadedAt ISO-8601 timestamp
 * @property {boolean} [confidential] Flag confidential
 * @property {string|null} [signature] Optional EIP-712/EIP-191 signature
 * @property {string|null} [merkleLeafHash] Optional merkle leaf hash nếu dùng merkleization
 */

/**
 * @typedef {Object} OnChainEvent
 * @property {string} name Tên event (ví dụ 'DisputeInitiated')
 * @property {string} txHash Transaction hash
 * @property {number} [blockNumber] Block number (tuỳ chọn)
 * @property {string} [timestamp] ISO-8601 timestamp (tuỳ chọn)
 */

/**
 * @typedef {Object} OnChainInfo
 * @property {string} [disputeContract] Address của dispute contract
 * @property {number} [disputeIndex] Index on-chain nếu có
 * @property {OnChainEvent[]} [events] Danh sách events liên quan
 */

/**
 * @typedef {Object} Mediator
 * @property {string} address Wallet address mediator
 * @property {string} status Trạng thái mediator (xem MEDIATOR_STATUS)
 * @property {string|null} [acceptedAt]
 * @property {string|null} [declinedAt]
 * @property {string|null} [votedAt]
 * @property {string|null} [voteChoice] Nếu đã vote, giá trị theo VOTE_CHOICE
 * @property {number|null} [score] Optional reputation score
 * @property {string|null} [note] Optional note
 */

/**
 * @typedef {Object} Vote
 * @property {string} mediator Mediator address
 * @property {string} vote Giá trị vote (VOTE_CHOICE)
 * @property {string} [justification] Lý do/justification
 * @property {string[]} evidenceRefs Array of Evidence.id
 * @property {string} timestamp ISO-8601
 * @property {string} signature EIP-712 signature
 */

/**
 * @typedef {Object} VoteTally
 * @property {number} RELEASE_TO_BUYER
 * @property {number} RETURN_TO_SELLER
 * @property {number} SPLIT
 * @property {number} OTHER
 * @property {number} totalVotes
 * @property {number} threshold
 */

/**
 * @typedef {Object} Dispute
 * @property {string} disputeId UUID
 * @property {string} escrowId Escrow identifier
 * @property {string} status Dispute status (DISPUTE_STATUS)
 * @property {string} initiatorAddress Initiator wallet address
 * @property {Mediator[]} mediators Array (thường length = 7 khi assigned)
 * @property {Evidence[]} evidence Evidence list
 * @property {string} createdAt ISO-8601
 * @property {string|null} [assignedAt]
 * @property {string|null} [finalizedAt]
 * @property {string|null} [outcome] Outcome (VOTE_CHOICE)
 * @property {OnChainInfo|null} [onChain]
 * @property {string|null} [requestId] Chainlink VRF request id (optional)
 * @property {string|null} [onChainTxHash] Optional initial tx hash
 * @property {string|null} [evidenceMerkleRoot] Optional merkle root
 */

/**
 * --- REST API payload typedefs (frontend ↔ backend) ---
 */

/**
 * @typedef {Object} CreateDisputeRequest
 * @property {string} escrowId
 * @property {string} initiatorAddress
 * @property {string} reason
 * @property {string} [description]
 * @property {string[]} [evidenceRefs] array of ipfs:// or evidence ids
 * @property {string} [onChainTxHash]
 */

/**
 * @typedef {Object} CreateDisputeResponse
 * @property {string} disputeId
 * @property {string} status
 * @property {string|null} [requestId]
 * @property {string|null} [onChainTxHash]
 */

/**
 * @typedef {Object} EvidenceUploadPayload
 * @property {string} uploaderAddress
 * @property {string} [description]
 * @property {boolean} [confidential]
 * @property {string|null} [signature]
 */

/**
 * @typedef {Object} EvidenceUploadResponse
 * @property {string} evidenceId
 * @property {string} ipfsHash
 * @property {FileMetadata} [metadata]
 * @property {string} uploadedAt
 */

/**
 * @typedef {Object} VoteSubmitRequest
 * @property {string} mediator
 * @property {string} vote
 * @property {string} [justification]
 * @property {string[]} evidenceRefs
 * @property {string} timestamp
 * @property {string} signature
 */

/**
 * @typedef {Object} VoteSubmitResponse
 * @property {'ACCEPTED'|'REJECTED'} status
 * @property {VoteTally} [currentTally]
 * @property {string} [message]
 */

/**
 * @typedef {Object} AcceptMediatorRequest
 * @property {string} mediator
 * @property {string} signature
 * @property {string} timestamp
 */

/**
 * @typedef {Object} AcceptMediatorResponse
 * @property {'ACCEPTED'|'DECLINED'} status
 * @property {string} [message]
 */

/**
 * @typedef {Object} FinalizeRequestInternal
 * @property {string} disputeId
 * @property {string} outcome
 * @property {Array<{mediator:string,signature:string,timestamp:string}>} signatures
 */

/**
 * @typedef {Object} FinalizeResponse
 * @property {string} onChainTxHash
 * @property {string} finalizedAt
 */

/**
 * --- WebSocket payload typedefs ---
 */

/**
 * @typedef {Object} WSDisputeCreated
 * @property {string} disputeId
 * @property {string} escrowId
 * @property {string} initiator
 * @property {string} status
 * @property {string} createdAt
 */

/**
 * @typedef {Object} WSMediatorsAssigned
 * @property {string} disputeId
 * @property {string[]} mediators
 * @property {string} assignedAt
 * @property {string|null} [requestId]
 */

/**
 * @typedef {Object} WSEvidenceAdded
 * @property {string} disputeId
 * @property {Evidence} evidence
 */

/**
 * @typedef {Object} WSVoteSubmitted
 * @property {string} disputeId
 * @property {string} mediator
 * @property {string} vote
 * @property {string} [justification]
 * @property {string} timestamp
 * @property {string} signature
 */

/**
 * @typedef {Object} WSVoteProgress
 * @property {string} disputeId
 * @property {VoteTally} tally
 * @property {number} totalVotes
 * @property {number} threshold
 */

/**
 * @typedef {Object} WSDisputeResolved
 * @property {string} disputeId
 * @property {string} outcome
 * @property {string} finalizedAt
 * @property {string} onChainTxHash
 * @property {string[]} resolvingMediators
 */

/**
 * @typedef {Object} WSDisputeTimedOut
 * @property {string} disputeId
 * @property {string} reason
 * @property {string} [nextSteps]
 */

/**
 * @typedef {Object} WSMediatorAssignmentInvite
 * @property {string} disputeId
 * @property {string} assignedAt
 * @property {string} expiresAt
 * @property {string} escrowId
 */
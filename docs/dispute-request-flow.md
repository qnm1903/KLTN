# Dispute Request Flow

This document describes the current dispute flow in the backend, starting from the frontend action and ending at the backend response, DB writes, WebSocket emits, and optional anchoring.

## Actors
- User Wallet
- Frontend
- Backend API
- Prisma DB
- Outbox Worker
- Socket.io
- Optional Anchor Service / Relayer

## Current idea
- Frontend signs EIP-712 typed data.
- Backend verifies the signature and validates the request context.
- Backend writes state and audit data in a single transaction.
- Backend stores a dispute event in the outbox table.
- Worker reads the outbox after commit and emits real-time events.
- Optional anchor worker batches outbox events and stores a Merkle root on IPFS or chain.

## End-to-end flow

### 1. Create dispute
Frontend action:
- User clicks the dispute button in the escrow UI.
- Frontend sends `POST /api/disputes`.

Request body:
```json
{
  "escrowId": "<escrow-id>",
  "reason": "Item not received",
  "description": "Optional details"
}
```

Backend behavior:
- Checks the caller is an escrow participant.
- Loads escrow and mediator slots.
- Rejects if an active dispute already exists.
- Creates the dispute and assigns mediators.
- Inserts outbox events for `DISPUTE_CREATED` and `MEDIATOR_ASSIGNED`.

Backend returns:
- `201 Created`
- CreateDisputeResponse payload:
  ```json
  {
    "disputeId": "<dispute-id>",
    "status": "MEDIATORS_ASSIGNED",
    "requestId": null,
    "onChainTxHash": null,
    "createdAt": "2026-05-01T12:00:00.000Z"
  }
  ```

### 2. Accept or decline mediator assignment
Frontend action:
- Mediator opens dispute detail page.
- Frontend signs an EIP-712 `AcceptMediator` message.
- Frontend sends `POST /api/disputes/:id/accept-mediator`.

Request body:
```json
{
  "decision": "accept",
  "signature": "0x...",
  "message": {
    "disputeId": "<dispute-id>",
    "escrowId": "<escrow-id>",
    "mediator": "0x...",
    "decision": "accept",
    "nonce": 12,
    "deadline": 1735766400
  }
}
```

Backend behavior:
- Rebuilds the trusted EIP-712 domain server-side.
- Verifies the signature against the mediator wallet.
- Confirms `disputeId`, `escrowId`, `mediator`, `decision` match the request.
- Checks `deadline`.
- In one DB transaction:
  - consumes mediator nonce,
  - updates mediator status,
  - stores `signature`, `messageRaw`, and `nonce` in the dispute-mediator row,
  - inserts an outbox event `MEDIATOR_ACCEPTED` or `MEDIATOR_DECLINED`.

Backend returns:
- `200 OK`
- Updated mediator assignment row.

### 3. Submit vote
Frontend action:
- Mediator selects a vote choice.
- Frontend signs an EIP-712 `Vote` message.
- Frontend sends `POST /api/disputes/:id/vote`.

Request body:
```json
{
  "vote": "RELEASE_TO_BUYER",
  "justification": "Buyer provided proof",
  "evidenceRefs": ["evidence-1"],
  "signature": "0x...",
  "message": {
    "disputeId": "<dispute-id>",
    "escrowId": "<escrow-id>",
    "vote": "RELEASE_TO_BUYER",
    "nonce": 13,
    "deadline": 1735766400
  }
}
```

Backend behavior:
- Checks the mediator is assigned to the dispute.
- Checks the mediator already accepted the assignment.
- Checks the dispute is still votable.
- Rebuilds the trusted EIP-712 domain.
- Verifies the signature and message binding.
- Checks `deadline`.
- In one DB transaction:
  - consumes mediator nonce,
  - creates `DisputeVote` with `signature` and `messageRaw`,
  - updates mediator status to `voted`,
  - inserts an outbox event `VOTE_SUBMITTED`.
- After that, the backend calls dispute finalization.

Backend returns:
- `201 Created`
- VoteSubmitResponse payload:
  ```json
  {
    "status": "ACCEPTED",
    "currentTally": {
      "RELEASE_TO_BUYER": 2,
      "RETURN_TO_SELLER": 1,
      "SPLIT": 0,
      "OTHER": 0,
      "totalVotes": 3,
      "threshold": 5
    }
  }
  ```

### 4. Sign evidence metadata
Frontend action:
- User signs evidence metadata for audit.
- Frontend sends `POST /api/disputes/:id/evidence/:evidenceId/signature`.

Request body:
```json
{
  "signature": "0x...",
  "message": {
    "disputeId": "<dispute-id>",
    "escrowId": "<escrow-id>",
    "evidenceId": "<evidence-id>",
    "nonce": 14,
    "deadline": 1735766400
  }
}
```

Backend behavior:
- Confirms the evidence belongs to the dispute escrow.
- Checks `disputeId`, `escrowId`, and `evidenceId` match the message.
- Checks `deadline`.
- Verifies the EIP-712 signature.
- In one DB transaction:
  - consumes nonce,
  - stores `signature` and `messageRaw` on the evidence row,
  - inserts an outbox event `EVIDENCE_SIGNED`.

Backend returns:
- `200 OK`
- Updated evidence row.

### 5. Finalize dispute
Frontend or backend action:
- After votes are enough, the backend computes the tally.
- Backend sends `POST /api/disputes/:id/finalize` when needed.

Backend behavior:
- Loads all votes and mediator state.
- Builds the tally.
- Resolves the outcome if a threshold is met.
- In one DB transaction:
  - inserts `VOTE_TALLY_UPDATED`,
  - updates dispute to `RESOLVED` if applicable,
  - inserts `DISPUTE_FINALIZED`.

Backend returns:
- Finalize response payload:
  ```json
  {
    "onChainTxHash": null,
    "finalizedAt": "2026-05-01T12:05:00.000Z"
  }
  ```

## What the backend returns at each step
- Create dispute: CreateDisputeResponse payload.
- Accept mediator: updated mediator row.
- Vote: VoteSubmitResponse payload.
- Evidence signature: updated evidence row.
- Finalize: onChainTxHash + finalizedAt.

## Outbox and real-time events
- The outbox table stores events inside the same transaction as the state change.
- The worker reads unprocessed events and emits Socket.io events.
- The worker marks the event processed after successful emit.
- This avoids losing events if the API process crashes after DB commit.

## Optional anchoring
- A separate anchor worker can batch processed dispute events.
- The worker can hash the batch into a Merkle root.
- The worker can upload the batch to IPFS and save the CID.
- The worker can optionally write the batch root on-chain through a small anchor registry contract.

## Data model notes
```prisma
model MediatorNonce {
  address      String   @id
  currentNonce Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model DisputeEvent {
  id           String   @id @default(uuid())
  disputeId    String
  escrowId     String
  type         String
  payload      Json
  attemptCount Int      @default(0)
  lastError    String?
  processedAt  DateTime?
  createdAt    DateTime @default(now())
}
```

## What to review in this flow
- The flow is fully off-chain for dispute voting.
- The current on-chain part is only optional anchoring.
- The main trust point is the backend, so nonce, deadline, audit trail, and outbox are required.
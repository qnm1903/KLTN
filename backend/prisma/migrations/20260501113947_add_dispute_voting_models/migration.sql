-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN "messageRaw" JSONB;
ALTER TABLE "Evidence" ADD COLUMN "signature" TEXT;

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VOTING',
    "initiatorAddress" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT,
    "onChainTxHash" TEXT,
    "requestId" TEXT,
    "assignedAt" DATETIME,
    "finalizedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Dispute_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DisputeMediator" (
    "disputeId" TEXT NOT NULL,
    "mediatorId" TEXT NOT NULL,
    "slot" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "acceptedAt" DATETIME,
    "declinedAt" DATETIME,
    "votedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("disputeId", "mediatorId"),
    CONSTRAINT "DisputeMediator_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DisputeMediator_mediatorId_fkey" FOREIGN KEY ("mediatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DisputeVote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "disputeId" TEXT NOT NULL,
    "mediatorId" TEXT NOT NULL,
    "vote" TEXT NOT NULL,
    "justification" TEXT NOT NULL DEFAULT '',
    "evidenceRefs" JSONB,
    "signature" TEXT NOT NULL,
    "messageRaw" JSONB NOT NULL,
    "votedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DisputeVote_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DisputeVote_mediatorId_fkey" FOREIGN KEY ("mediatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediatorNonce" (
    "address" TEXT NOT NULL PRIMARY KEY,
    "currentNonce" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Dispute_escrowId_idx" ON "Dispute"("escrowId");

-- CreateIndex
CREATE INDEX "Dispute_status_idx" ON "Dispute"("status");

-- CreateIndex
CREATE INDEX "Dispute_createdAt_idx" ON "Dispute"("createdAt");

-- CreateIndex
CREATE INDEX "DisputeMediator_mediatorId_idx" ON "DisputeMediator"("mediatorId");

-- CreateIndex
CREATE INDEX "DisputeMediator_status_idx" ON "DisputeMediator"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeMediator_disputeId_slot_key" ON "DisputeMediator"("disputeId", "slot");

-- CreateIndex
CREATE INDEX "DisputeVote_disputeId_votedAt_idx" ON "DisputeVote"("disputeId", "votedAt");

-- CreateIndex
CREATE INDEX "DisputeVote_mediatorId_idx" ON "DisputeVote"("mediatorId");

-- CreateIndex
CREATE UNIQUE INDEX "DisputeVote_disputeId_mediatorId_key" ON "DisputeVote"("disputeId", "mediatorId");

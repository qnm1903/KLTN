-- AlterTable
ALTER TABLE "Escrow" ADD COLUMN "decisionDeadlineAt" DATETIME;
ALTER TABLE "Escrow" ADD COLUMN "disputeOpenedAt" DATETIME;
ALTER TABLE "Escrow" ADD COLUMN "disputePhase" TEXT;
ALTER TABLE "Escrow" ADD COLUMN "evidenceDeadlineAt" DATETIME;
ALTER TABLE "Escrow" ADD COLUMN "reviewDeadlineAt" DATETIME;

-- CreateTable
CREATE TABLE "EscrowStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "source" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" TEXT, //SQLite
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EscrowStatusHistory_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EscrowStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EscrowStatusHistory_escrowId_createdAt_idx" ON "EscrowStatusHistory"("escrowId", "createdAt");

-- CreateIndex
CREATE INDEX "EscrowStatusHistory_source_createdAt_idx" ON "EscrowStatusHistory"("source", "createdAt");

-- CreateIndex
CREATE INDEX "Escrow_status_disputePhase_idx" ON "Escrow"("status", "disputePhase");

-- CreateIndex
CREATE INDEX "Escrow_disputePhase_evidenceDeadlineAt_idx" ON "Escrow"("disputePhase", "evidenceDeadlineAt");

-- CreateIndex
CREATE INDEX "Escrow_disputePhase_reviewDeadlineAt_idx" ON "Escrow"("disputePhase", "reviewDeadlineAt");

-- CreateIndex
CREATE INDEX "Escrow_disputePhase_decisionDeadlineAt_idx" ON "Escrow"("disputePhase", "decisionDeadlineAt");

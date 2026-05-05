-- AlterTable
ALTER TABLE "DisputeMediator" ADD COLUMN "messageRaw" JSONB;
ALTER TABLE "DisputeMediator" ADD COLUMN "nonce" INTEGER;
ALTER TABLE "DisputeMediator" ADD COLUMN "signature" TEXT;

-- CreateTable
CREATE TABLE "DisputeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "disputeId" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DisputeEvent_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DisputeEvent_processedAt_createdAt_idx" ON "DisputeEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "DisputeEvent_disputeId_createdAt_idx" ON "DisputeEvent"("disputeId", "createdAt");

-- CreateIndex
CREATE INDEX "DisputeEvent_escrowId_createdAt_idx" ON "DisputeEvent"("escrowId", "createdAt");

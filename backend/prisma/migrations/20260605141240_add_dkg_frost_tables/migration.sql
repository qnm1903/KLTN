/*
  Warnings:

  - You are about to drop the column `mediatorPoolUsed` on the `Escrow` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "NonceSubmission" ADD COLUMN "nonceR2_x" TEXT;
ALTER TABLE "NonceSubmission" ADD COLUMN "nonceR2_y" TEXT;

-- CreateTable
CREATE TABLE "DkgCommitment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "commitments" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DkgCommitment_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DkgShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "fromRole" TEXT NOT NULL,
    "toRole" TEXT NOT NULL,
    "encryptedBlob" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DkgShare_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Escrow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainEscrowId" TEXT,
    "contractAddress" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "disputePhase" TEXT,
    "mediatorsSelectedAt" DATETIME,
    "confirmDeadline" DATETIME,
    "timeoutDeadline" DATETIME,
    "disputeOpenedAt" DATETIME,
    "evidenceDeadlineAt" DATETIME,
    "reviewDeadlineAt" DATETIME,
    "decisionDeadlineAt" DATETIME,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "pkAggBsX" TEXT,
    "pkAggBsY" TEXT,
    "pkAggBmX" TEXT,
    "pkAggBmY" TEXT,
    "pkAggSmX" TEXT,
    "pkAggSmY" TEXT,
    "dkgDueAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Escrow_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Escrow_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Escrow" ("amount", "buyerId", "chainEscrowId", "confirmDeadline", "contractAddress", "createdAt", "decisionDeadlineAt", "description", "disputeOpenedAt", "disputePhase", "evidenceDeadlineAt", "id", "mediatorsSelectedAt", "pkAggBmX", "pkAggBmY", "pkAggBsX", "pkAggBsY", "pkAggSmX", "pkAggSmY", "reviewDeadlineAt", "sellerId", "status", "timeoutDeadline", "title", "updatedAt") SELECT "amount", "buyerId", "chainEscrowId", "confirmDeadline", "contractAddress", "createdAt", "decisionDeadlineAt", "description", "disputeOpenedAt", "disputePhase", "evidenceDeadlineAt", "id", "mediatorsSelectedAt", "pkAggBmX", "pkAggBmY", "pkAggBsX", "pkAggBsY", "pkAggSmX", "pkAggSmY", "reviewDeadlineAt", "sellerId", "status", "timeoutDeadline", "title", "updatedAt" FROM "Escrow";
DROP TABLE "Escrow";
ALTER TABLE "new_Escrow" RENAME TO "Escrow";
CREATE INDEX "Escrow_status_timeoutDeadline_idx" ON "Escrow"("status", "timeoutDeadline");
CREATE INDEX "Escrow_status_confirmDeadline_idx" ON "Escrow"("status", "confirmDeadline");
CREATE INDEX "Escrow_status_disputePhase_idx" ON "Escrow"("status", "disputePhase");
CREATE INDEX "Escrow_disputePhase_evidenceDeadlineAt_idx" ON "Escrow"("disputePhase", "evidenceDeadlineAt");
CREATE INDEX "Escrow_disputePhase_reviewDeadlineAt_idx" ON "Escrow"("disputePhase", "reviewDeadlineAt");
CREATE INDEX "Escrow_disputePhase_decisionDeadlineAt_idx" ON "Escrow"("disputePhase", "decisionDeadlineAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DkgCommitment_escrowId_idx" ON "DkgCommitment"("escrowId");

-- CreateIndex
CREATE UNIQUE INDEX "DkgCommitment_escrowId_role_key" ON "DkgCommitment"("escrowId", "role");

-- CreateIndex
CREATE INDEX "DkgShare_escrowId_toRole_idx" ON "DkgShare"("escrowId", "toRole");

-- CreateIndex
CREATE UNIQUE INDEX "DkgShare_escrowId_fromRole_toRole_key" ON "DkgShare"("escrowId", "fromRole", "toRole");

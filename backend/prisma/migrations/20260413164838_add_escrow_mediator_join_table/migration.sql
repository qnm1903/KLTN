/*
  Warnings:

  - You are about to drop the column `mediatorId` on the `Escrow` table. All the data in the column will be lost.
  - You are about to alter the column `metadata` on the `EscrowStatusHistory` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.
  - You are about to alter the column `payload` on the `SigningSession` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- CreateTable
CREATE TABLE "EscrowMediator" (
    "escrowId" TEXT NOT NULL,
    "mediatorId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("escrowId", "mediatorId"),
    CONSTRAINT "EscrowMediator_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EscrowMediator_mediatorId_fkey" FOREIGN KEY ("mediatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Escrow_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Escrow_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Escrow" ("amount", "buyerId", "chainEscrowId", "confirmDeadline", "contractAddress", "createdAt", "decisionDeadlineAt", "description", "disputeOpenedAt", "disputePhase", "evidenceDeadlineAt", "id", "pkAggBmX", "pkAggBmY", "pkAggBsX", "pkAggBsY", "pkAggSmX", "pkAggSmY", "reviewDeadlineAt", "sellerId", "status", "timeoutDeadline", "title", "updatedAt") SELECT "amount", "buyerId", "chainEscrowId", "confirmDeadline", "contractAddress", "createdAt", "decisionDeadlineAt", "description", "disputeOpenedAt", "disputePhase", "evidenceDeadlineAt", "id", "pkAggBmX", "pkAggBmY", "pkAggBsX", "pkAggBsY", "pkAggSmX", "pkAggSmY", "reviewDeadlineAt", "sellerId", "status", "timeoutDeadline", "title", "updatedAt" FROM "Escrow";
DROP TABLE "Escrow";
ALTER TABLE "new_Escrow" RENAME TO "Escrow";
CREATE INDEX "Escrow_status_timeoutDeadline_idx" ON "Escrow"("status", "timeoutDeadline");
CREATE INDEX "Escrow_status_confirmDeadline_idx" ON "Escrow"("status", "confirmDeadline");
CREATE INDEX "Escrow_status_disputePhase_idx" ON "Escrow"("status", "disputePhase");
CREATE INDEX "Escrow_disputePhase_evidenceDeadlineAt_idx" ON "Escrow"("disputePhase", "evidenceDeadlineAt");
CREATE INDEX "Escrow_disputePhase_reviewDeadlineAt_idx" ON "Escrow"("disputePhase", "reviewDeadlineAt");
CREATE INDEX "Escrow_disputePhase_decisionDeadlineAt_idx" ON "Escrow"("disputePhase", "decisionDeadlineAt");
CREATE TABLE "new_EscrowStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "source" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EscrowStatusHistory_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EscrowStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_EscrowStatusHistory" ("actorUserId", "createdAt", "escrowId", "fromStatus", "id", "metadata", "reason", "source", "toStatus") SELECT "actorUserId", "createdAt", "escrowId", "fromStatus", "id", "metadata", "reason", "source", "toStatus" FROM "EscrowStatusHistory";
DROP TABLE "EscrowStatusHistory";
ALTER TABLE "new_EscrowStatusHistory" RENAME TO "EscrowStatusHistory";
CREATE INDEX "EscrowStatusHistory_escrowId_createdAt_idx" ON "EscrowStatusHistory"("escrowId", "createdAt");
CREATE INDEX "EscrowStatusHistory_source_createdAt_idx" ON "EscrowStatusHistory"("source", "createdAt");
CREATE TABLE "new_PubKeySubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pubKey" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PubKeySubmission_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PubKeySubmission" ("escrowId", "id", "pubKey", "role", "submittedAt", "updatedAt") SELECT "escrowId", "id", "pubKey", "role", "submittedAt", "updatedAt" FROM "PubKeySubmission";
DROP TABLE "PubKeySubmission";
ALTER TABLE "new_PubKeySubmission" RENAME TO "PubKeySubmission";
CREATE INDEX "PubKeySubmission_escrowId_idx" ON "PubKeySubmission"("escrowId");
CREATE UNIQUE INDEX "PubKeySubmission_escrowId_role_key" ON "PubKeySubmission"("escrowId", "role");
CREATE TABLE "new_SigningSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SigningSession" ("createdAt", "escrowId", "expiresAt", "id", "payload", "status", "updatedAt") SELECT "createdAt", "escrowId", "expiresAt", "id", "payload", "status", "updatedAt" FROM "SigningSession";
DROP TABLE "SigningSession";
ALTER TABLE "new_SigningSession" RENAME TO "SigningSession";
CREATE UNIQUE INDEX "SigningSession_escrowId_key" ON "SigningSession"("escrowId");
CREATE INDEX "SigningSession_status_expiresAt_idx" ON "SigningSession"("status", "expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "EscrowMediator_mediatorId_idx" ON "EscrowMediator"("mediatorId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowMediator_escrowId_slot_key" ON "EscrowMediator"("escrowId", "slot");

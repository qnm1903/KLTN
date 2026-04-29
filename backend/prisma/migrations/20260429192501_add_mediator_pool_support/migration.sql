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
    "mediatorPoolUsed" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "isMediator" BOOLEAN NOT NULL DEFAULT false,
    "mediatorStake" DECIMAL NOT NULL DEFAULT 0,
    "mediatorRegisteredAt" DATETIME,
    "mediatorTimeoutCount" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_User" ("createdAt", "id", "name", "role", "updatedAt", "walletAddress") SELECT "createdAt", "id", "name", "role", "updatedAt", "walletAddress" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");
CREATE INDEX "User_isMediator_idx" ON "User"("isMediator");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

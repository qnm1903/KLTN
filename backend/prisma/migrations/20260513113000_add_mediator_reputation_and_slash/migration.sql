-- CreateTable
CREATE TABLE "MediatorReputationHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediatorAddress" TEXT NOT NULL,
    "oldScore" INTEGER NOT NULL,
    "newScore" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MediatorSlash" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediatorAddress" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appealDeadlineAt" DATETIME NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "MediatorReputationHistory_txHash_logIndex_key" ON "MediatorReputationHistory"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "MediatorReputationHistory_mediatorAddress_createdAt_idx" ON "MediatorReputationHistory"("mediatorAddress", "createdAt");

-- CreateIndex
CREATE INDEX "MediatorReputationHistory_blockNumber_idx" ON "MediatorReputationHistory"("blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MediatorSlash_txHash_logIndex_key" ON "MediatorSlash"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "MediatorSlash_mediatorAddress_createdAt_idx" ON "MediatorSlash"("mediatorAddress", "createdAt");

-- CreateIndex
CREATE INDEX "MediatorSlash_status_appealDeadlineAt_idx" ON "MediatorSlash"("status", "appealDeadlineAt");

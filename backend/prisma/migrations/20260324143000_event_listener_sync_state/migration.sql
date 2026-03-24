-- CreateTable
CREATE TABLE "EventSyncState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "lastProcessedBlock" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProcessedChainEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "escrowId" TEXT,
    "blockNumber" INTEGER NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedChainEvent_txHash_logIndex_key" ON "ProcessedChainEvent"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "ProcessedChainEvent_escrowId_idx" ON "ProcessedChainEvent"("escrowId");

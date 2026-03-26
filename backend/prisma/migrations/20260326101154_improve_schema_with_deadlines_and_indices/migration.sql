/*
  Warnings:

  - You are about to alter the column `amount` on the `Escrow` table. The data in that column could be lost. The data in that column will be cast from `Float` to `Decimal`.

*/
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
    "confirmDeadline" DATETIME,
    "timeoutDeadline" DATETIME,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "mediatorId" TEXT NOT NULL,
    "pkAggBsX" TEXT,
    "pkAggBsY" TEXT,
    "pkAggBmX" TEXT,
    "pkAggBmY" TEXT,
    "pkAggSmX" TEXT,
    "pkAggSmY" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Escrow_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Escrow_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Escrow_mediatorId_fkey" FOREIGN KEY ("mediatorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Escrow" ("amount", "buyerId", "chainEscrowId", "confirmDeadline", "contractAddress", "createdAt", "description", "id", "mediatorId", "pkAggBmX", "pkAggBmY", "pkAggBsX", "pkAggBsY", "pkAggSmX", "pkAggSmY", "sellerId", "status", "timeoutDeadline", "title", "updatedAt") SELECT "amount", "buyerId", "chainEscrowId", "confirmDeadline", "contractAddress", "createdAt", "description", "id", "mediatorId", "pkAggBmX", "pkAggBmY", "pkAggBsX", "pkAggBsY", "pkAggSmX", "pkAggSmY", "sellerId", "status", "timeoutDeadline", "title", "updatedAt" FROM "Escrow";
DROP TABLE "Escrow";
ALTER TABLE "new_Escrow" RENAME TO "Escrow";
CREATE INDEX "Escrow_status_timeoutDeadline_idx" ON "Escrow"("status", "timeoutDeadline");
CREATE INDEX "Escrow_status_confirmDeadline_idx" ON "Escrow"("status", "confirmDeadline");
CREATE TABLE "new_Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evidence_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evidence_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Evidence" ("createdAt", "description", "escrowId", "fileUrl", "id", "uploaderId") SELECT "createdAt", "description", "escrowId", "fileUrl", "id", "uploaderId" FROM "Evidence";
DROP TABLE "Evidence";
ALTER TABLE "new_Evidence" RENAME TO "Evidence";
CREATE INDEX "Evidence_escrowId_idx" ON "Evidence"("escrowId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

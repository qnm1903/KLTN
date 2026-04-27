-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SigningSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SigningSession_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SigningSession" ("createdAt", "escrowId", "expiresAt", "id", "payload", "status", "updatedAt") SELECT "createdAt", "escrowId", "expiresAt", "id", "payload", "status", "updatedAt" FROM "SigningSession";
DROP TABLE "SigningSession";
ALTER TABLE "new_SigningSession" RENAME TO "SigningSession";
CREATE UNIQUE INDEX "SigningSession_escrowId_key" ON "SigningSession"("escrowId");
CREATE INDEX "SigningSession_status_expiresAt_idx" ON "SigningSession"("status", "expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

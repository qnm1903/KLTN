-- CreateTable
CREATE TABLE "SigningSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SigningSession_escrowId_key" ON "SigningSession"("escrowId");

-- CreateIndex
CREATE INDEX "SigningSession_status_expiresAt_idx" ON "SigningSession"("status", "expiresAt");

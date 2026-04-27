-- CreateTable
CREATE TABLE "NonceSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "nonceR_x" TEXT NOT NULL,
    "nonceR_y" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "NonceSubmission_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "NonceSubmission_escrowId_action_idx" ON "NonceSubmission"("escrowId", "action");

-- CreateIndex
CREATE INDEX "NonceSubmission_expiresAt_idx" ON "NonceSubmission"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NonceSubmission_escrowId_action_role_key" ON "NonceSubmission"("escrowId", "action", "role");

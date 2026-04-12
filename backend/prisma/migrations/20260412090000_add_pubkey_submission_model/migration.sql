-- CreateTable
CREATE TABLE "PubKeySubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pubKey" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PubKeySubmission_escrowId_role_key" ON "PubKeySubmission"("escrowId", "role");

-- CreateIndex
CREATE INDEX "PubKeySubmission_escrowId_idx" ON "PubKeySubmission"("escrowId");

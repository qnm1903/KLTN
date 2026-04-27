-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "escrowId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "approvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Approval_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Approval_escrowId_action_idx" ON "Approval"("escrowId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_escrowId_action_userId_key" ON "Approval"("escrowId", "action", "userId");

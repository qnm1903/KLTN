CREATE TABLE "AuthNonce" (
  "address" TEXT NOT NULL PRIMARY KEY,
  "nonce" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AuthNonce_expiresAt_idx" ON "AuthNonce"("expiresAt");
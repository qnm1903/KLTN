-- Remove schnorr signature fields that are not needed in dispute voting phase
-- (Schnorr TSS will be handled by escrow happy path reuse, not separate dispute flow)

ALTER TABLE "DisputeMediator" DROP COLUMN "schnorrSigRefund";
ALTER TABLE "DisputeMediator" DROP COLUMN "schnorrSigRelease";

ALTER TABLE "DisputeVote" DROP COLUMN "schnorrSigRefund";
ALTER TABLE "DisputeVote" DROP COLUMN "schnorrSigRelease";

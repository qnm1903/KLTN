// In-memory map: escrowId -> { pubKeys, pkAgg, nonces, zShares, signingRoles, signingAction, round2Context, completedActions, createdAt, status, parties }
export const sessions = new Map();
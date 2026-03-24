const ALLOWED_TRANSITIONS = {
  DRAFT: new Set(['INITIALIZED', 'LOCKED', 'DISPUTED', 'RELEASED', 'REFUNDED']),
  INITIALIZED: new Set(['LOCKED', 'DISPUTED', 'RELEASED', 'REFUNDED']),
  LOCKED: new Set(['DISPUTED', 'RELEASED', 'REFUNDED']),
  DISPUTED: new Set(['RELEASED', 'REFUNDED']),
  RELEASED: new Set(),
  REFUNDED: new Set()
};

export function normalizeEscrowStatus(status) {
  if (typeof status !== 'string') return null;
  const normalized = status.toUpperCase();
  return ALLOWED_TRANSITIONS[normalized] ? normalized : null;
}

export function canTransitionStatus(currentStatus, nextStatus) {
  const current = normalizeEscrowStatus(currentStatus);
  const next = normalizeEscrowStatus(nextStatus);
  if (!next) return false;
  if (!current) return false;
  if (current === next) return true;
  return ALLOWED_TRANSITIONS[current].has(next);
}

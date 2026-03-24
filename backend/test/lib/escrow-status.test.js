import { canTransitionStatus } from '../../src/lib/escrow-status.js';

describe('canTransitionStatus', () => {
  it('returns false when current status is invalid', () => {
    expect(canTransitionStatus(null, 'LOCKED')).toBe(false);
    expect(canTransitionStatus('UNKNOWN', 'LOCKED')).toBe(false);
  });

  it('keeps same-state transitions valid for idempotent retries', () => {
    expect(canTransitionStatus('LOCKED', 'LOCKED')).toBe(true);
  });
});

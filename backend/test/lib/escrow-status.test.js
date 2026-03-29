import { canTransitionStatus } from '../../src/lib/escrow-status.js';

describe('canTransitionStatus', () => {
  it('returns false when current status is invalid', () => {
    expect(canTransitionStatus(null, 'LOCKED')).toBe(false);
    expect(canTransitionStatus('UNKNOWN', 'LOCKED')).toBe(false);
  });

  it('keeps same-state transitions valid for idempotent retries', () => {
    expect(canTransitionStatus('LOCKED', 'LOCKED')).toBe(true);
  });

  it('blocks unsafe direct jumps from DRAFT/INITIALIZED to terminal states', () => {
    expect(canTransitionStatus('DRAFT', 'RELEASED')).toBe(false);
    expect(canTransitionStatus('DRAFT', 'REFUNDED')).toBe(false);
    expect(canTransitionStatus('INITIALIZED', 'RELEASED')).toBe(false);
    expect(canTransitionStatus('INITIALIZED', 'REFUNDED')).toBe(false);
  });

  it('allows dispute and resolution transitions in later stages', () => {
    expect(canTransitionStatus('INITIALIZED', 'DISPUTED')).toBe(true);
    expect(canTransitionStatus('LOCKED', 'DISPUTED')).toBe(true);
    expect(canTransitionStatus('DISPUTED', 'RELEASED')).toBe(true);
    expect(canTransitionStatus('DISPUTED', 'REFUNDED')).toBe(true);
  });
});

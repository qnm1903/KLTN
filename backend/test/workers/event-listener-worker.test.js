import { getLogIndex } from '../../src/workers/event-listener-worker.js';

describe('getLogIndex', () => {
  it('returns log.index when present', () => {
    expect(getLogIndex({ index: 3 })).toBe(3);
  });

  it('returns log.logIndex when index is missing', () => {
    expect(getLogIndex({ logIndex: 7 })).toBe(7);
  });

  it('returns null when both index and logIndex are missing', () => {
    expect(getLogIndex({})).toBeNull();
  });

  it('returns null for non-numeric values', () => {
    expect(getLogIndex({ index: 'not-a-number' })).toBeNull();
  });
});

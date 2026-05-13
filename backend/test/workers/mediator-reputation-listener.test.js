import { jest } from '@jest/globals';

const emitToRoom = jest.fn();

jest.unstable_mockModule('../../src/lib/socket-emitter.js', () => ({
  emitToRoom
}));

const {
  handleReputationUpdated,
  handleMediatorSlashed
} = await import('../../src/workers/mediator-reputation-listener.js');

describe('mediator-reputation-listener handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes reputation history and emits websocket event', async () => {
    const prisma = {
      mediatorReputationHistory: {
        create: jest.fn().mockResolvedValue({ id: 'h1', createdAt: new Date('2026-05-13T00:00:00.000Z') })
      }
    };

    const event = {
      log: {
        transactionHash: '0xabc',
        index: 1,
        blockNumber: 42
      }
    };

    await handleReputationUpdated({
      prisma,
      mediator: '0x1111111111111111111111111111111111111111',
      oldScore: 95n,
      newScore: 90n,
      event,
      logger: console
    });

    expect(prisma.mediatorReputationHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mediatorAddress: '0x1111111111111111111111111111111111111111',
        oldScore: 95,
        newScore: 90,
        delta: -5,
        txHash: '0xabc',
        logIndex: 1,
        blockNumber: 42
      })
    });

    expect(emitToRoom).toHaveBeenCalledWith(
      'mediator:0x1111111111111111111111111111111111111111',
      'mediator:reputation-updated',
      expect.objectContaining({
        oldScore: 95,
        newScore: 90,
        delta: -5,
        txHash: '0xabc'
      })
    );
  });

  it('writes slash record with pending status and 3-day appeal deadline', async () => {
    const now = new Date('2026-05-13T00:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    const prisma = {
      mediatorSlash: {
        create: jest.fn().mockResolvedValue({ id: 's1', createdAt: now })
      }
    };

    await handleMediatorSlashed({
      prisma,
      mediator: '0x2222222222222222222222222222222222222222',
      amount: 30n,
      event: {
        log: {
          transactionHash: '0xdef',
          index: 2,
          blockNumber: 99
        }
      },
      logger: console
    });

    const createCall = prisma.mediatorSlash.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('PENDING');
    expect(createCall.data.amount).toBe('30');
    expect(new Date(createCall.data.appealDeadlineAt).getTime()).toBe(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    expect(emitToRoom).toHaveBeenCalledWith(
      'mediator:0x2222222222222222222222222222222222222222',
      'mediator:slashed',
      expect.objectContaining({
        id: 's1',
        amount: '30',
        status: 'PENDING',
        txHash: '0xdef'
      })
    );

    jest.useRealTimers();
  });
});

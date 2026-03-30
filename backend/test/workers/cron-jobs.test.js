import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import {
  checkDisputePhaseTransitions,
  checkTimeoutEscrows,
  cleanupExpiredFiles,
  startCronJobs,
  stopCronJobs
} from '../../src/workers/cron-jobs.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('cron-jobs', () => {
  afterEach(() => {
    stopCronJobs({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });
  });

  it('updates LOCKED escrows that passed timeout deadline', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      escrow: { updateMany },
      authNonce: { deleteMany: jest.fn() },
      evidence: { findMany: jest.fn() }
    };

    const now = new Date('2026-03-26T10:00:00.000Z');
    const result = await checkTimeoutEscrows(prisma, { now, logger: console });

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'LOCKED',
        timeoutDeadline: {
          not: null,
          lt: now
        }
      },
      data: expect.objectContaining({
        status: 'DISPUTED',
        disputePhase: 'OPENED',
        disputeOpenedAt: now,
        evidenceDeadlineAt: expect.any(Date),
        reviewDeadlineAt: expect.any(Date),
        decisionDeadlineAt: expect.any(Date)
      })
    }));
    expect(result).toEqual({ updatedEscrows: 2 });
  });

  it('does not update when no timed out escrows exist', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      escrow: { updateMany },
      authNonce: { deleteMany: jest.fn() },
      evidence: { findMany: jest.fn() }
    };

    const result = await checkTimeoutEscrows(prisma, { now: new Date(), logger: console });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ updatedEscrows: 0 });
  });

  it('writes status history per escrow when transaction-capable prisma is available', async () => {
    const now = new Date('2026-03-26T10:00:00.000Z');

    const txEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txHistoryCreate = jest.fn().mockResolvedValue({ id: 'history-1' });

    const prisma = {
      escrow: {
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { id: 'escrow-1', status: 'LOCKED' },
          { id: 'escrow-2', status: 'LOCKED' }
        ])
      },
      escrowStatusHistory: {
        create: jest.fn()
      },
      $transaction: jest.fn(async (callback) => callback({
        escrow: {
          updateMany: txEscrowUpdateMany
        },
        escrowStatusHistory: {
          create: txHistoryCreate
        }
      })),
      authNonce: { deleteMany: jest.fn() },
      evidence: { findMany: jest.fn() }
    };

    const result = await checkTimeoutEscrows(prisma, { now, logger: console });

    expect(prisma.escrow.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(txEscrowUpdateMany).toHaveBeenCalledTimes(2);
    expect(txHistoryCreate).toHaveBeenCalledTimes(2);
    expect(txHistoryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: 'CRON_TIMEOUT',
        fromStatus: 'LOCKED',
        toStatus: 'DISPUTED'
      })
    }));
    expect(result).toEqual({ updatedEscrows: 2 });
  });

  it('progresses dispute phases by deadlines and records CRON_PHASE history', async () => {
    const now = new Date('2026-03-26T10:00:00.000Z');

    const txEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txHistoryCreate = jest.fn().mockResolvedValue({ id: 'history-1' });

    const prisma = {
      escrow: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'escrow-opened',
            status: 'DISPUTED',
            disputePhase: 'OPENED',
            disputeOpenedAt: new Date('2026-03-25T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-27T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-28T00:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-03-29T00:00:00.000Z')
          },
          {
            id: 'escrow-evidence',
            status: 'DISPUTED',
            disputePhase: 'EVIDENCE_WINDOW',
            disputeOpenedAt: new Date('2026-03-22T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-24T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-27T00:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-03-29T00:00:00.000Z')
          },
          {
            id: 'escrow-review',
            status: 'DISPUTED',
            disputePhase: 'REVIEW_WINDOW',
            disputeOpenedAt: new Date('2026-03-22T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-23T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-24T00:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-03-29T00:00:00.000Z')
          },
          {
            id: 'escrow-decision',
            status: 'DISPUTED',
            disputePhase: 'DECISION_PENDING',
            disputeOpenedAt: new Date('2026-03-20T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-21T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-22T00:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-03-24T00:00:00.000Z')
          }
        ])
      },
      escrowStatusHistory: {
        create: jest.fn()
      },
      $transaction: jest.fn(async (callback) => callback({
        escrow: {
          updateMany: txEscrowUpdateMany
        },
        escrowStatusHistory: {
          create: txHistoryCreate
        }
      }))
    };

    const result = await checkDisputePhaseTransitions(prisma, { now, logger: console });

    expect(prisma.escrow.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    expect(txEscrowUpdateMany).toHaveBeenCalledTimes(4);
    expect(txEscrowUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ disputePhase: 'RESOLVED' })
    }));
    expect(txHistoryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: 'CRON_PHASE',
        fromStatus: 'DISPUTED',
        toStatus: 'DISPUTED'
      })
    }));
    expect(result).toEqual({ progressedEscrows: 4 });
  });

  it('deletes expired nonces and keeps referenced files', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-cleanup-'));
    const uploadsDir = path.join(tmpRoot, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });

    const referencedName = 'keep.txt';
    const orphanName = 'remove.txt';
    await fs.writeFile(path.join(uploadsDir, referencedName), 'keep');
    await fs.writeFile(path.join(uploadsDir, orphanName), 'remove');

    const prisma = {
      escrow: { updateMany: jest.fn() },
      authNonce: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      evidence: {
        findMany: jest.fn().mockResolvedValue([{ fileUrl: `/uploads/${referencedName}` }])
      }
    };

    const result = await cleanupExpiredFiles(prisma, {
      now: new Date('2026-03-26T10:00:00.000Z'),
      uploadsDir,
      logger: console
    });

    const keepExists = await fs.stat(path.join(uploadsDir, referencedName)).then(() => true).catch(() => false);
    const removeExists = await fs.stat(path.join(uploadsDir, orphanName)).then(() => true).catch(() => false);

    expect(prisma.authNonce.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.evidence.findMany).toHaveBeenCalledWith({ select: { fileUrl: true } });
    expect(keepExists).toBe(true);
    expect(removeExists).toBe(false);
    expect(result).toEqual({ deletedNonces: 1, deletedFiles: 1, orphanCandidates: 1 });

    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('handles missing uploads directory gracefully', async () => {
    const prisma = {
      escrow: { updateMany: jest.fn() },
      authNonce: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      evidence: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };

    const result = await cleanupExpiredFiles(prisma, {
      now: new Date(),
      uploadsDir: path.join(os.tmpdir(), `missing-${Date.now()}`),
      logger: console
    });

    expect(result).toEqual({ deletedNonces: 0, deletedFiles: 0, orphanCandidates: 0 });
  });

  it('schedules jobs and prevents overlap on timeout job', async () => {
    const callbacks = new Map();
    const handles = [];

    const schedule = jest.fn((pattern, callback) => {
      callbacks.set(pattern, callback);
      const handle = { stop: jest.fn() };
      handles.push(handle);
      return handle;
    });

    const validate = jest.fn().mockReturnValue(true);
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const longRunning = deferred();
    const prisma = {
      escrow: {
        updateMany: jest.fn().mockImplementation(() => longRunning.promise)
      },
      authNonce: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      evidence: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };

    const timeoutPattern = '*/1 * * * *';
    const cleanupPattern = '*/2 * * * *';

    startCronJobs(prisma, { schedule, validate, logger, timeoutPattern, cleanupPattern });

    const timeoutCallback = callbacks.get(timeoutPattern);
    expect(timeoutCallback).toBeDefined();

    const firstTick = timeoutCallback();
    const secondTick = timeoutCallback();
    await Promise.resolve();

    expect(prisma.escrow.updateMany).toHaveBeenCalledTimes(1);

    // Check that overlap skip metric was logged
    const skippedCallArgs = logger.info
      .mock.calls.find((call) => {
        try {
          const log = JSON.parse(call[0]);
          return log.event === 'cron.timeout_check.skipped';
        } catch {
          return false;
        }
      });
    expect(skippedCallArgs).toBeDefined();

    longRunning.resolve({ count: 1 });
    await firstTick;
    await secondTick;

    stopCronJobs({ logger });
    expect(handles[0].stop).toHaveBeenCalledTimes(1);
    expect(handles[1].stop).toHaveBeenCalledTimes(1);
  });
});

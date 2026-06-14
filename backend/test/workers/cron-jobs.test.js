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

  it('triggers on-chain timeout for LOCKED escrows past deadline', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'e1', contractAddress: '0xabc' },
      { id: 'e2', contractAddress: '0xdef' }
    ]);
    const triggerTimeoutOnChain = jest.fn().mockResolvedValue({ triggered: true });
    const prisma = { escrow: { findMany } };

    const now = new Date('2026-03-26T10:00:00.000Z');
    const result = await checkTimeoutEscrows(prisma, { now, logger: console, triggerTimeoutOnChain });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'LOCKED',
        timeoutDeadline: { not: null, lt: now },
        contractAddress: { not: null }
      },
      select: { id: true, contractAddress: true }
    }));
    expect(triggerTimeoutOnChain).toHaveBeenCalledTimes(2);
    expect(triggerTimeoutOnChain).toHaveBeenCalledWith('0xabc', expect.anything());
    expect(result).toEqual({ triggeredEscrows: 2, updatedEscrows: 2 });
  });

  it('does nothing when no timed out escrows exist', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const triggerTimeoutOnChain = jest.fn();
    const prisma = { escrow: { findMany } };

    const result = await checkTimeoutEscrows(prisma, { now: new Date(), logger: console, triggerTimeoutOnChain });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(triggerTimeoutOnChain).not.toHaveBeenCalled();
    expect(result).toEqual({ triggeredEscrows: 0, updatedEscrows: 0 });
  });

  it('only counts escrows that were actually triggered (idempotent skips)', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'e1', contractAddress: '0xabc' },
      { id: 'e2', contractAddress: '0xdef' }
    ]);
    // e2 đã được ai đó bấm nút trước (on-chain không còn LOCKED) → triggered=false.
    const triggerTimeoutOnChain = jest.fn()
      .mockResolvedValueOnce({ triggered: true })
      .mockResolvedValueOnce({ triggered: false, reason: 'not_locked' });
    const prisma = { escrow: { findMany } };

    const result = await checkTimeoutEscrows(prisma, { now: new Date(), logger: console, triggerTimeoutOnChain });

    expect(triggerTimeoutOnChain).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ triggeredEscrows: 1, updatedEscrows: 1 });
  });

  it('progresses dispute phases by deadlines and records CRON_PHASE history', async () => {
    const now = new Date('2026-03-30T10:00:00.000Z');

    const txEscrowUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txHistoryCreate = jest.fn().mockResolvedValue({ id: 'history-1' });

    const prisma = {
      escrow: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'escrow-opened',
            status: 'DISPUTED',
            disputePhase: 'OPENED',
            disputeOpenedAt: new Date('2026-03-29T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-04-02T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-04-04T00:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-04-05T00:00:00.000Z')
          },
          {
            id: 'escrow-evidence',
            status: 'DISPUTED',
            disputePhase: 'EVIDENCE_WINDOW',
            disputeOpenedAt: new Date('2026-03-24T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-30T09:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-31T10:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-04-01T10:00:00.000Z')
          },
          {
            id: 'escrow-review',
            status: 'DISPUTED',
            disputePhase: 'REVIEW_WINDOW',
            disputeOpenedAt: new Date('2026-03-22T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-23T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-30T09:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-04-01T00:00:00.000Z')
          },
          {
            id: 'escrow-decision',
            status: 'DISPUTED',
            disputePhase: 'DECISION_PENDING',
            disputeOpenedAt: new Date('2026-03-20T00:00:00.000Z'),
            evidenceDeadlineAt: new Date('2026-03-21T00:00:00.000Z'),
            reviewDeadlineAt: new Date('2026-03-22T00:00:00.000Z'),
            decisionDeadlineAt: new Date('2026-03-30T09:00:00.000Z')
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
    expect(txEscrowUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'escrow-opened',
        status: 'DISPUTED',
        disputePhase: 'OPENED'
      },
      data: {
        disputePhase: 'EVIDENCE_WINDOW'
      }
    });
    expect(txEscrowUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'escrow-evidence',
        status: 'DISPUTED',
        disputePhase: 'EVIDENCE_WINDOW'
      },
      data: {
        disputePhase: 'REVIEW_WINDOW'
      }
    });
    expect(txEscrowUpdateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: 'escrow-review',
        status: 'DISPUTED',
        disputePhase: 'REVIEW_WINDOW'
      },
      data: {
        disputePhase: 'DECISION_PENDING'
      }
    });
    expect(txEscrowUpdateMany).toHaveBeenNthCalledWith(4, {
      where: {
        id: 'escrow-decision',
        status: 'DISPUTED',
        disputePhase: 'DECISION_PENDING'
      },
      data: {
        disputePhase: 'RESOLVED'
      }
    });

    expect(txHistoryCreate).toHaveBeenCalledTimes(4);
    expect(txHistoryCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        escrowId: 'escrow-opened',
        source: 'CRON_PHASE',
        fromStatus: 'DISPUTED',
        toStatus: 'DISPUTED',
        reason: 'opened acknowledgment elapsed',
        metadata: expect.objectContaining({
          fromPhase: 'OPENED',
          toPhase: 'EVIDENCE_WINDOW',
          triggeredAt: now.toISOString()
        })
      })
    }));
    expect(txHistoryCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        escrowId: 'escrow-evidence',
        source: 'CRON_PHASE',
        fromStatus: 'DISPUTED',
        toStatus: 'DISPUTED',
        reason: 'evidence window elapsed',
        metadata: expect.objectContaining({
          fromPhase: 'EVIDENCE_WINDOW',
          toPhase: 'REVIEW_WINDOW',
          triggeredAt: now.toISOString()
        })
      })
    }));
    expect(txHistoryCreate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      data: expect.objectContaining({
        escrowId: 'escrow-review',
        source: 'CRON_PHASE',
        fromStatus: 'DISPUTED',
        toStatus: 'DISPUTED',
        reason: 'review window elapsed',
        metadata: expect.objectContaining({
          fromPhase: 'REVIEW_WINDOW',
          toPhase: 'DECISION_PENDING',
          triggeredAt: now.toISOString()
        })
      })
    }));
    expect(txHistoryCreate).toHaveBeenNthCalledWith(4, expect.objectContaining({
      data: expect.objectContaining({
        escrowId: 'escrow-decision',
        source: 'CRON_PHASE',
        fromStatus: 'DISPUTED',
        toStatus: 'DISPUTED',
        reason: 'decision grace elapsed',
        metadata: expect.objectContaining({
          fromPhase: 'DECISION_PENDING',
          toPhase: 'RESOLVED',
          triggeredAt: now.toISOString()
        })
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
        findMany: jest.fn().mockImplementation(() => longRunning.promise)
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

    expect(prisma.escrow.findMany).toHaveBeenCalledTimes(1);

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

    longRunning.resolve([]);
    await firstTick;
    await secondTick;

    stopCronJobs({ logger });
    expect(handles[0].stop).toHaveBeenCalledTimes(1);
    expect(handles[1].stop).toHaveBeenCalledTimes(1);
  });
});

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { jest } from '@jest/globals';
import { checkTimeoutEscrows, cleanupExpiredFiles, startCronJobs, stopCronJobs } from '../../src/workers/cron-jobs.js';

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

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: 'LOCKED',
        timeoutDeadline: {
          not: null,
          lt: now
        }
      },
      data: {
        status: 'DISPUTED'
      }
    });
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

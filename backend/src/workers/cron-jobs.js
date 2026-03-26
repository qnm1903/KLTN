import cron from 'node-cron';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UPLOADS_DIR = path.join(__dirname, '../../uploads');
const DEFAULT_TIMEOUT_CRON = process.env.TIMEOUT_CHECK_CRON_PATTERN || '0 * * * *';
const DEFAULT_CLEANUP_CRON = process.env.CLEANUP_CRON_PATTERN || '0 2 * * *';

let timeoutCheckJob = null;
let fileCleanupJob = null;
let timeoutCheckInProgress = false;
let fileCleanupInProgress = false;

function logMetric(logger, event, metrics, duration, status = 'success') {
  const log = {
    timestamp: new Date().toISOString(),
    event,
    metrics,
    duration,
    status
  };
  logger.info?.(JSON.stringify(log));
}

function toFileBasename(fileUrl) {
  if (!fileUrl) return null;
  const normalized = fileUrl.replace(/\\/g, '/');
  const withoutQuery = normalized.split('?')[0].split('#')[0];
  const basename = path.posix.basename(withoutQuery);
  return basename || null;
}

async function checkTimeoutEscrows(prisma, options = {}) {
  const logger = options.logger ?? console;
  const now = options.now ?? new Date();
  const startTime = Date.now();

  const updated = await prisma.escrow.updateMany({
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

  const duration = Date.now() - startTime;
  logMetric(logger, 'cron.timeout_check.completed', { updated: updated.count }, duration);

  return { updatedEscrows: updated.count };
}

async function cleanupExpiredFiles(prisma, options = {}) {
  const logger = options.logger ?? console;
  const now = options.now ?? new Date();
  const uploadsDir = options.uploadsDir ?? DEFAULT_UPLOADS_DIR;
  const startTime = Date.now();

  const deletedNonces = await prisma.authNonce.deleteMany({
    where: {
      expiresAt: { lt: now }
    }
  });

  const referenced = await prisma.evidence.findMany({
    select: { fileUrl: true }
  });

  const referencedBasenames = new Set(
    referenced
      .map((row) => toFileBasename(row.fileUrl))
      .filter(Boolean)
  );

  let deletedFiles = 0;
  let orphanCandidates = 0;

  try {
    const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (referencedBasenames.has(entry.name)) continue;

      orphanCandidates += 1;

      const target = path.join(uploadsDir, entry.name);
      try {
        await fs.unlink(target);
        deletedFiles += 1;
      } catch (error) {
        logger.warn?.(`[cron] Failed to remove file ${entry.name}: ${error.message}`);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const duration = Date.now() - startTime;
  logMetric(logger, 'cron.file_cleanup.completed', {
    deletedNonces: deletedNonces.count,
    deletedFiles,
    orphanCandidates
  }, duration);

  return {
    deletedNonces: deletedNonces.count,
    deletedFiles,
    orphanCandidates
  };
}

export function startCronJobs(prisma, options = {}) {
  const logger = options.logger ?? console;
  const timeoutPattern = options.timeoutPattern ?? DEFAULT_TIMEOUT_CRON;
  const cleanupPattern = options.cleanupPattern ?? DEFAULT_CLEANUP_CRON;
  const schedule = options.schedule ?? cron.schedule;
  const validate = options.validate ?? cron.validate;

  if (!validate(timeoutPattern)) {
    throw new Error(`Invalid timeout cron pattern: ${timeoutPattern}`);
  }
  if (!validate(cleanupPattern)) {
    throw new Error(`Invalid cleanup cron pattern: ${cleanupPattern}`);
  }

  if (!timeoutCheckJob) {
    timeoutCheckJob = schedule(timeoutPattern, async () => {
      if (timeoutCheckInProgress) {
        logMetric(logger, 'cron.timeout_check.skipped', { reason: 'already_running' }, 0);
        return;
      }

      timeoutCheckInProgress = true;
      const startTime = Date.now();
      try {
        await checkTimeoutEscrows(prisma, { logger });
      } catch (error) {
        const duration = Date.now() - startTime;
        logMetric(logger, 'cron.timeout_check.failed', { error: error.message }, duration, 'failed');
      } finally {
        timeoutCheckInProgress = false;
      }
    });
    logMetric(logger, 'cron.job.scheduled', { job: 'timeout_check', pattern: timeoutPattern }, 0);
  }

  if (!fileCleanupJob) {
    fileCleanupJob = schedule(cleanupPattern, async () => {
      if (fileCleanupInProgress) {
        logMetric(logger, 'cron.file_cleanup.skipped', { reason: 'already_running' }, 0);
        return;
      }

      fileCleanupInProgress = true;
      const startTime = Date.now();
      try {
        await cleanupExpiredFiles(prisma, { logger });
      } catch (error) {
        const duration = Date.now() - startTime;
        logMetric(logger, 'cron.file_cleanup.failed', { error: error.message }, duration, 'failed');
      } finally {
        fileCleanupInProgress = false;
      }
    });
    logMetric(logger, 'cron.job.scheduled', { job: 'file_cleanup', pattern: cleanupPattern }, 0);
  }

  logMetric(logger, 'cron.started', { totalJobs: 2 }, 0);
}

export function stopCronJobs(options = {}) {
  const logger = options.logger ?? console;
  let stoppedJobs = 0;

  if (timeoutCheckJob) {
    timeoutCheckJob.stop();
    timeoutCheckJob = null;
    stoppedJobs += 1;
  }

  if (fileCleanupJob) {
    fileCleanupJob.stop();
    fileCleanupJob = null;
    stoppedJobs += 1;
  }

  timeoutCheckInProgress = false;
  fileCleanupInProgress = false;

  logMetric(logger, 'cron.stopped', { stoppedJobs }, 0);
}

export { checkTimeoutEscrows, cleanupExpiredFiles };
import cron from 'node-cron';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { buildDisputeLifecycleData, DISPUTE_PHASES, resolveNextDisputePhase } from '../lib/dispute-lifecycle.js';

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

  // Backward-compatible fallback for tests/mocks that only provide updateMany.
  const hasHistoryModel = Boolean(prisma.escrowStatusHistory);
  const hasTransactions = typeof prisma.$transaction === 'function';
  const hasFindMany = typeof prisma.escrow?.findMany === 'function';

  if (!hasHistoryModel || !hasTransactions || !hasFindMany) {
    const updated = await prisma.escrow.updateMany({
      where: {
        status: 'LOCKED',
        timeoutDeadline: {
          not: null,
          lt: now
        }
      },
      data: {
        status: 'DISPUTED',
        ...buildDisputeLifecycleData('LOCKED', 'DISPUTED', now)
      }
    });

    const duration = Date.now() - startTime;
    logMetric(logger, 'cron.timeout_check.completed', { updated: updated.count }, duration);

    return { updatedEscrows: updated.count };
  }

  const timedOutEscrows = await prisma.escrow.findMany({
    where: {
      status: 'LOCKED',
      timeoutDeadline: {
        not: null,
        lt: now
      }
    },
    select: {
      id: true,
      status: true
    }
  });

  let updatedCount = 0;

  for (const escrow of timedOutEscrows) {
    try {
      await prisma.$transaction(async (tx) => {
        const guarded = await tx.escrow.updateMany({
          where: {
            id: escrow.id,
            status: 'LOCKED'
          },
          data: {
            status: 'DISPUTED',
            ...buildDisputeLifecycleData('LOCKED', 'DISPUTED', now)
          }
        });

        if (guarded.count !== 1) return;

        await tx.escrowStatusHistory.create({
          data: {
            escrowId: escrow.id,
            actorUserId: null,
            source: 'CRON_TIMEOUT',
            fromStatus: 'LOCKED',
            toStatus: 'DISPUTED',
            reason: 'timeout reached',
            metadata: {
              triggeredAt: now.toISOString()
            }
          }
        });

        updatedCount += 1;
      });
    } catch (error) {
      logger.error?.('[cron] Failed to process timeout escrow transition', {
        escrowId: escrow.id,
        error
      });
      continue;
    }
  }

  const duration = Date.now() - startTime;
  logMetric(logger, 'cron.timeout_check.completed', { updated: updatedCount }, duration);

  return { updatedEscrows: updatedCount };
}

async function checkDisputePhaseTransitions(prisma, options = {}) {
  const logger = options.logger ?? console;
  const now = options.now ?? new Date();
  const startTime = Date.now();

  const hasHistoryModel = Boolean(prisma.escrowStatusHistory);
  const hasTransactions = typeof prisma.$transaction === 'function';
  const hasFindMany = typeof prisma.escrow?.findMany === 'function';

  if (!hasHistoryModel || !hasTransactions || !hasFindMany) {
    const duration = Date.now() - startTime;
    logMetric(logger, 'cron.dispute_phase_check.completed', { progressed: 0, skipped: true }, duration);
    return { progressedEscrows: 0 };
  }

  const disputedEscrows = await prisma.escrow.findMany({
    where: {
      status: 'DISPUTED',
      OR: [
        { disputePhase: null },
        { disputePhase: DISPUTE_PHASES.OPENED, disputeOpenedAt: { not: null } },
        { disputePhase: DISPUTE_PHASES.EVIDENCE_WINDOW, evidenceDeadlineAt: { not: null } },
        { disputePhase: DISPUTE_PHASES.REVIEW_WINDOW, reviewDeadlineAt: { not: null } },
        { disputePhase: DISPUTE_PHASES.DECISION_PENDING, decisionDeadlineAt: { not: null } }
      ]
    },
    select: {
      id: true,
      status: true,
      disputePhase: true,
      disputeOpenedAt: true,
      evidenceDeadlineAt: true,
      reviewDeadlineAt: true,
      decisionDeadlineAt: true
    }
  });

  let progressedCount = 0;

  for (const escrow of disputedEscrows) {
    const transition = resolveNextDisputePhase(escrow, now);
    if (!transition) continue;
    if (!transition.nextPhase) {
      logger.error?.('[cron] Skipping dispute phase transition because lifecycle data is invalid', {
        escrowId: escrow.id,
        disputePhase: escrow.disputePhase || null,
        transition
      });
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const where = {
          id: escrow.id,
          status: 'DISPUTED',
          disputePhase: escrow.disputePhase ?? null
        };

        const updateData = {
          disputePhase: transition.nextPhase
        };

        if (transition.nextPhase === DISPUTE_PHASES.OPENED && !escrow.disputeOpenedAt) {
          Object.assign(updateData, buildDisputeLifecycleData('LOCKED', 'DISPUTED', now));
        }

        const guarded = await tx.escrow.updateMany({ where, data: updateData });
        if (guarded.count !== 1) return;

        await tx.escrowStatusHistory.create({
          data: {
            escrowId: escrow.id,
            actorUserId: null,
            source: 'CRON_PHASE',
            fromStatus: 'DISPUTED',
            toStatus: 'DISPUTED',
            reason: transition.reason,
            metadata: {
              fromPhase: escrow.disputePhase || null,
              toPhase: transition.nextPhase,
              triggeredAt: now.toISOString()
            }
          }
        });

        progressedCount += 1;
      });
    } catch (error) {
      logger.error?.('[cron] Failed to process dispute phase transition', {
        escrowId: escrow.id,
        fromPhase: escrow.disputePhase || null,
        toPhase: transition.nextPhase,
        reason: transition.reason || null,
        error
      });
      continue;
    }
  }

  const duration = Date.now() - startTime;
  logMetric(logger, 'cron.dispute_phase_check.completed', { progressed: progressedCount }, duration);
  return { progressedEscrows: progressedCount };
}

async function cleanupExpiredFiles(prisma, options = {}) {
  const logger = options.logger ?? console;
  const now = options.now ?? new Date();
  const uploadsDir = options.uploadsDir ?? DEFAULT_UPLOADS_DIR;
  const startTime = Date.now();

  const deletedSessions = typeof prisma.signingSession?.deleteMany === 'function'
    ? await prisma.signingSession.deleteMany({
      where: {
        OR: [
          { status: 'EXPIRED' },
          { expiresAt: { lt: now } }
        ]
      }
    })
    : { count: 0 };

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
    deletedSessions: deletedSessions.count,
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
        const timeoutResult = await checkTimeoutEscrows(prisma, { logger });
        const phaseResult = await checkDisputePhaseTransitions(prisma, { logger });
        const duration = Date.now() - startTime;
        logMetric(logger, 'cron.timeout_pipeline.completed', {
          updatedEscrows: timeoutResult.updatedEscrows,
          progressedEscrows: phaseResult.progressedEscrows
        }, duration);
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

export { checkTimeoutEscrows, checkDisputePhaseTransitions, cleanupExpiredFiles };
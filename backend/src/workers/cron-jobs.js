import cron from 'node-cron';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { buildDisputeLifecycleData, DISPUTE_PHASES, resolveNextDisputePhase } from '../lib/dispute-lifecycle.js';
import { triggerTimeoutOnChain, executeMediationTimeout } from '../services/timeout-resolution-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UPLOADS_DIR = path.join(__dirname, '../../uploads');
const DEFAULT_TIMEOUT_CRON = process.env.TIMEOUT_CHECK_CRON_PATTERN || '0 * * * *';
const DEFAULT_CLEANUP_CRON = process.env.CLEANUP_CRON_PATTERN || '0 2 * * *';

let timeoutCheckJob = null;
let fileCleanupJob = null;
let nonceCleanupJob = null;
let disputeExecutionRetryJob = null;
let timeoutCheckInProgress = false;
let fileCleanupInProgress = false;
let nonceCleanupInProgress = false;
let disputeExecutionRetryInProgress = false;

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
  // Relayer fallback có thể inject để test; mặc định gọi contract thật.
  const trigger = options.triggerTimeoutOnChain ?? triggerTimeoutOnChain;

  const hasFindMany = typeof prisma.escrow?.findMany === 'function';
  if (!hasFindMany) {
    return { triggeredEscrows: 0, updatedEscrows: 0 };
  }

  // Contract là nguồn sự thật cho LOCKED→DISPUTED: relayer gọi triggerTimeout() on-chain,
  // DB sẽ tự chuyển DISPUTED qua event DisputeOpened (event listener). Đây là fallback cho
  // trường hợp không bên nào bấm nút trên FE.
  const timedOutEscrows = await prisma.escrow.findMany({
    where: {
      status: 'LOCKED',
      timeoutDeadline: { not: null, lt: now },
      contractAddress: { not: null }
    },
    select: { id: true, contractAddress: true }
  });

  let triggeredCount = 0;

  for (const escrow of timedOutEscrows) {
    try {
      const result = await trigger(escrow.contractAddress, { logger });
      if (result?.triggered) triggeredCount += 1;
    } catch (error) {
      logger.error?.('[cron] Failed to trigger on-chain timeout', {
        escrowId: escrow.id,
        error: error.message
      });
      continue;
    }
  }

  const duration = Date.now() - startTime;
  logMetric(logger, 'cron.timeout_check.completed', { triggered: triggeredCount }, duration);

  // Giữ alias updatedEscrows cho log pipeline tương thích ngược.
  return { triggeredEscrows: triggeredCount, updatedEscrows: triggeredCount };
}

async function checkDisputePhaseTransitions(prisma, options = {}) {
  const logger = options.logger ?? console;
  const now = options.now ?? new Date();
  const startTime = Date.now();
  // Bước 4: hết hạn trong hòa giải → chia đôi + phạt MV. Injectable để test.
  const runMediationTimeout = options.executeMediationTimeout ?? executeMediationTimeout;

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
      let committed = false;
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
        committed = true;
      });

      // Bước 4: khi hòa giải hết hạn (DECISION_PENDING → RESOLVED) mà không có phán quyết,
      // chạy chia đôi tiền + phạt MV on-chain (executor tự kiểm tra idempotency on-chain).
      if (committed && transition.nextPhase === DISPUTE_PHASES.RESOLVED) {
        try {
          const result = await runMediationTimeout({ prisma, escrowId: escrow.id, logger });
          logMetric(logger, 'cron.mediation_timeout.executed', { escrowId: escrow.id, ...result }, 0);
        } catch (execError) {
          logMetric(logger, 'cron.mediation_timeout.failed', { escrowId: escrow.id, error: execError.message }, 0, 'failed');
        }
      }
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

async function cleanupExpiredNonces(prisma, logger = console) {
  const startTime = Date.now();
  try {
    const deleted = await prisma.nonceSubmission.deleteMany({
      where: {
        expiresAt: { lt: new Date() }
      }
    });
    const duration = Date.now() - startTime;
    logger.info?.(`[cron] Cleaned up ${deleted.count} expired nonce submissions (${duration}ms)`);
    return deleted.count;
  } catch (error) {
    logger.warn?.(`[cron] Failed to clean up expired nonces: ${error.message}`);
    return 0;
  }
}

export function startCronJobs(prisma, options = {}) {
  const logger = options.logger ?? console;
  const timeoutPattern = options.timeoutPattern ?? DEFAULT_TIMEOUT_CRON;
  const cleanupPattern = options.cleanupPattern ?? DEFAULT_CLEANUP_CRON;
  const nonceCleanupPattern = options.nonceCleanupPattern ?? '*/5 * * * *'; // Every 5 minutes
  const schedule = options.schedule ?? cron.schedule;
  const validate = options.validate ?? cron.validate;

  if (!validate(timeoutPattern)) {
    throw new Error(`Invalid timeout cron pattern: ${timeoutPattern}`);
  }
  if (!validate(cleanupPattern)) {
    throw new Error(`Invalid cleanup cron pattern: ${cleanupPattern}`);
  }
  if (!validate(nonceCleanupPattern)) {
    throw new Error(`Invalid nonce cleanup cron pattern: ${nonceCleanupPattern}`);
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

  if (!nonceCleanupJob) {
    nonceCleanupJob = schedule(nonceCleanupPattern, async () => {
      if (nonceCleanupInProgress) {
        logMetric(logger, 'cron.nonce_cleanup.skipped', { reason: 'already_running' }, 0);
        return;
      }

      nonceCleanupInProgress = true;
      const startTime = Date.now();
      try {
        await cleanupExpiredNonces(prisma, logger);
      } catch (error) {
        const duration = Date.now() - startTime;
        logMetric(logger, 'cron.nonce_cleanup.failed', { error: error.message }, duration, 'failed');
      } finally {
        nonceCleanupInProgress = false;
      }
    });
    logMetric(logger, 'cron.job.scheduled', { job: 'nonce_cleanup', pattern: nonceCleanupPattern }, 0);
  }

  // // Phase 4: Retry stuck dispute executions every 5 minutes
  // const disputeRetryPattern = options.disputeRetryPattern ?? '*/5 * * * *';
  // if (!validate(disputeRetryPattern)) {
  //   throw new Error(`Invalid dispute retry cron pattern: ${disputeRetryPattern}`);
  // }

  // if (!disputeExecutionRetryJob) {
  //   disputeExecutionRetryJob = schedule(disputeRetryPattern, async () => {
  //     if (disputeExecutionRetryInProgress) {
  //       logMetric(logger, 'cron.dispute_retry.skipped', { reason: 'already_running' }, 0);
  //       return;
  //     }

  //     disputeExecutionRetryInProgress = true;
  //     const startTime = Date.now();
  //     try {
  //       const result = await retryStuckExecutions();
  //       const duration = Date.now() - startTime;
  //       logMetric(logger, 'cron.dispute_retry.completed', {
  //         retried: result.retried,
  //         failed: result.failed,
  //         total: result.total
  //       }, duration);
  //     } catch (error) {
  //       const duration = Date.now() - startTime;
  //       logMetric(logger, 'cron.dispute_retry.failed', { error: error.message }, duration, 'failed');
  //     } finally {
  //       disputeExecutionRetryInProgress = false;
  //     }
  //   });
  //   logMetric(logger, 'cron.job.scheduled', { job: 'dispute_execution_retry', pattern: disputeRetryPattern }, 0);
  // }

  logMetric(logger, 'cron.started', { totalJobs: 4 }, 0);
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

if (nonceCleanupJob) {
  nonceCleanupJob.stop();
  nonceCleanupJob = null;
  stoppedJobs += 1;
}

if (disputeExecutionRetryJob) {
  disputeExecutionRetryJob.stop();
  disputeExecutionRetryJob = null;
  stoppedJobs += 1;
}

timeoutCheckInProgress = false;
fileCleanupInProgress = false;
nonceCleanupInProgress = false;
disputeExecutionRetryInProgress = false;

logMetric(logger, 'cron.stopped', { stoppedJobs }, 0);
}

export { checkTimeoutEscrows, checkDisputePhaseTransitions, cleanupExpiredFiles, cleanupExpiredNonces };
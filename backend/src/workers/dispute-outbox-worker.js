import prisma from '../lib/prisma.js';
import {
  emitDisputeCreated,
  emitDisputeFinalized,
  emitEvidenceSigned,
  emitMediatorAccepted,
  emitMediatorAssigned,
  emitMediatorDeclined,
  emitVoteSubmitted,
  emitVoteTallyUpdated,
  emitExecutionTriggered,
  emitExecutionCompleted,
  emitExecutionFailed
} from '../lib/socket-emitter.js';

const DEFAULT_INTERVAL_MS = Number(process.env.DISPUTE_OUTBOX_INTERVAL_MS ?? 1000);
const DEFAULT_BATCH_SIZE = Number(process.env.DISPUTE_OUTBOX_BATCH_SIZE ?? 50);

function toObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function emitOutboxEvent(event, logger = console) {
  const payload = toObject(event.payload);

  switch (event.type) {
    case 'DISPUTE_CREATED':
      emitDisputeCreated(event.escrowId, payload);
      return;
    case 'MEDIATOR_ASSIGNED':
      emitMediatorAssigned(event.escrowId, payload);
      return;
    case 'MEDIATOR_ACCEPTED':
      emitMediatorAccepted(event.escrowId, payload);
      return;
    case 'MEDIATOR_DECLINED':
      emitMediatorDeclined(event.escrowId, payload);
      return;
    case 'VOTE_SUBMITTED':
      emitVoteSubmitted(event.escrowId, payload);
      return;
    case 'VOTE_TALLY_UPDATED':
      emitVoteTallyUpdated(event.escrowId, payload);
      return;
    case 'DISPUTE_FINALIZED':
      emitDisputeFinalized(event.escrowId, payload);
      return;
    case 'EVIDENCE_SIGNED':
      emitEvidenceSigned(event.escrowId, payload);
      return;
    case 'EXECUTION_TRIGGERED':
      emitExecutionTriggered(event.escrowId, payload);
      return;
    case 'EXECUTION_COMPLETED':
      emitExecutionCompleted(event.escrowId, payload);
      return;
    case 'EXECUTION_FAILED':
      emitExecutionFailed(event.escrowId, payload);
      return;
    default:
      logger?.warn?.(`[outbox] Unknown event type ${event.type}, skipping event ${event.id}`);
  }
}

async function markFailedEvent(prismaClient, eventId, errorMessage) {
  await prismaClient.disputeEvent.update({
    where: { id: eventId },
    data: {
      attemptCount: { increment: 1 },
      lastError: String(errorMessage || 'Unknown outbox error')
    }
  });
}

async function markProcessedEvent(prismaClient, eventId) {
  await prismaClient.disputeEvent.update({
    where: { id: eventId },
    data: {
      processedAt: new Date(),
      lastError: null
    }
  });
}

export function startDisputeOutboxWorker({
  prisma: prismaClient = prisma,
  logger = console,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE
} = {}) {
  let stopped = false;
  let running = false;
  let timer = null;

  const tick = async () => {
    if (stopped || running) {
      return;
    }

    running = true;
    try {
      const events = await prismaClient.disputeEvent.findMany({
        where: { processedAt: null },
        orderBy: { createdAt: 'asc' },
        take: batchSize
      });

      for (const event of events) {
        try {
          emitOutboxEvent(event, logger);
          await markProcessedEvent(prismaClient, event.id);
        } catch (error) {
          logger?.error?.('[outbox] Failed to emit event:', error?.message ?? error);
          await markFailedEvent(prismaClient, event.id, error?.message ?? error);
        }
      }
    } catch (error) {
      logger?.error?.('[outbox] Worker tick failed:', error?.message ?? error);
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(tick, 0);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
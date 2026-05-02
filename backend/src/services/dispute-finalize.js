import prisma from '../lib/prisma.js';
import { DISPUTE_EVENT_TYPES, queueDisputeEvent } from '../lib/dispute-outbox.js';

const VOTE_THRESHOLD = 5;

function buildTally(votes) {
  const tally = {
    RELEASE_TO_BUYER: 0,
    RETURN_TO_SELLER: 0,
    SPLIT: 0,
    OTHER: 0
  };

  for (const row of votes) {
    if (!row?.vote) continue;
    if (!Object.prototype.hasOwnProperty.call(tally, row.vote)) {
      tally.OTHER += 1;
      continue;
    }
    tally[row.vote] += 1;
  }

  return tally;
}

function resolveOutcome(tally, threshold) {
  for (const [key, value] of Object.entries(tally)) {
    if (value >= threshold) {
      return key;
    }
  }
  return null;
}

export async function finalizeDisputeVotes(disputeId, options = {}) {
  const threshold = Number(options.threshold || VOTE_THRESHOLD);

  return prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        escrowId: true,
        status: true,
        outcome: true,
        votes: { select: { vote: true, mediatorId: true, votedAt: true } },
        mediators: { select: { mediatorId: true, status: true } }
      }
    });

    if (!dispute) {
      throw new Error('Dispute not found');
    }

    const tally = buildTally(dispute.votes || []);
    const outcome = resolveOutcome(tally, threshold);

    await queueDisputeEvent(tx, {
      disputeId: dispute.id,
      escrowId: dispute.escrowId,
      type: DISPUTE_EVENT_TYPES.VOTE_TALLY_UPDATED,
      payload: {
        disputeId: dispute.id,
        escrowId: dispute.escrowId,
        tally,
        totalVotes: dispute.votes.length,
        threshold,
        status: dispute.status
      }
    });

    if (!outcome || dispute.status === 'RESOLVED') {
      return { finalized: false, disputeId: dispute.id, tally, threshold, outcome: dispute.outcome };
    }

    const updatedDispute = await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: 'RESOLVED',
        outcome,
        finalizedAt: new Date()
      }
    });

    await queueDisputeEvent(tx, {
      disputeId: updatedDispute.id,
      escrowId: updatedDispute.escrowId,
      type: DISPUTE_EVENT_TYPES.DISPUTE_FINALIZED,
      payload: {
        disputeId: updatedDispute.id,
        escrowId: updatedDispute.escrowId,
        outcome: updatedDispute.outcome,
        finalizedAt: updatedDispute.finalizedAt,
        tally,
        threshold
      }
    });

    return {
      finalized: true,
      disputeId: updatedDispute.id,
      outcome: updatedDispute.outcome,
      finalizedAt: updatedDispute.finalizedAt,
      tally,
      threshold
    };
  });
}
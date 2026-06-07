import prisma from '../lib/prisma.js';
import { DISPUTE_EVENT_TYPES, queueDisputeEvent } from '../lib/dispute-outbox.js';

// A side needs 4 of 5 votes to win decisively. A 3-2 split (no side reaches 4)
// is resolved as SPLIT once all 5 have voted.
const VOTE_THRESHOLD = 4;

// Map any stored vote value (incl. legacy) to canonical RELEASE/REFUND/SPLIT.
//   RELEASE = funds to seller, REFUND = funds to buyer
function canonicalizeVote(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'RELEASE' || v === 'RELEASE_TO_SELLER' || v === 'RETURN_TO_SELLER' || v === 'RETURN') return 'RELEASE';
  if (v === 'REFUND' || v === 'REFUND_TO_BUYER' || v === 'RELEASE_TO_BUYER') return 'REFUND';
  if (v === 'SPLIT') return 'SPLIT';
  return 'OTHER';
}

function buildTally(votes) {
  const tally = {
    RELEASE: 0,
    REFUND: 0,
    SPLIT: 0,
    OTHER: 0
  };

  for (const row of votes) {
    if (!row?.vote) continue;
    tally[canonicalizeVote(row.vote)] += 1;
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
    // First try the normal threshold-based outcome
    let outcome = resolveOutcome(tally, threshold);

    // No outcome by threshold -> apply deadlock handling rules.
    // 1) If all 5 mediators voted and counts are 3 and 2, treat as SPLIT.
    // 2) If the dispute timed out (caller sets options.timedOut=true) and
    //    the top two choices are tied (e.g., 2-2), treat as SPLIT as a fallback.
    if (!outcome) {
      const totalVotes = Object.values(tally).reduce((s, v) => s + Number(v || 0), 0);

      // Get counts sorted descending: [[choice, count], ...]
      const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const topCount = Number(sorted[0]?.[1] || 0);
      const secondCount = Number(sorted[1]?.[1] || 0);

      // Case A: classic 3-2 (all 5 voted)
      if (totalVotes === 5 && topCount === 3 && secondCount === 2) {
        outcome = 'SPLIT';
      }

      // Case B: dispute expired (timed out) with a tie between top two choices
      // e.g., 2-2 when only 4 votes were cast — treat tie as SPLIT fallback.
      if (!outcome && options?.timedOut) {
        if (topCount > 0 && topCount === secondCount) {
          outcome = 'SPLIT';
        }
      }
    }

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
      return { finalized: false, disputeId: dispute.id, escrowId: dispute.escrowId, tally, threshold, outcome: dispute.outcome };
    }

    const updatedDispute = await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: 'RESOLVED',
        outcome,
        finalizedAt: new Date()
      }
    });

    // Outcome is action-aligned: RELEASE → release() (funds to seller),
    // REFUND → refund() (funds to buyer), SPLIT → split() (50/50).
    let tssAction = 'timeout';
    if (outcome === 'RELEASE') tssAction = 'release';
    if (outcome === 'REFUND') tssAction = 'refund';
    if (outcome === 'SPLIT') tssAction = 'split';

    await queueDisputeEvent(tx, {
      disputeId: updatedDispute.id,
      escrowId: updatedDispute.escrowId,
      type: DISPUTE_EVENT_TYPES.DISPUTE_FINALIZED,
      payload: {
        disputeId: updatedDispute.id,
        escrowId: updatedDispute.escrowId,
        tally,
        totalVotes: dispute.votes.length,
        threshold,
        status: updatedDispute.status,
        outcome: updatedDispute.outcome,
        tssAction: tssAction 
      }
    });

    return { finalized: true, disputeId: dispute.id, escrowId: dispute.escrowId, tally, threshold, outcome, tssAction };
  });
}
export const DISPUTE_EVENT_TYPES = {
  DISPUTE_CREATED: 'DISPUTE_CREATED',
  MEDIATOR_ASSIGNED: 'MEDIATOR_ASSIGNED',
  MEDIATOR_ACCEPTED: 'MEDIATOR_ACCEPTED',
  MEDIATOR_DECLINED: 'MEDIATOR_DECLINED',
  VOTE_SUBMITTED: 'VOTE_SUBMITTED',
  VOTE_TALLY_UPDATED: 'VOTE_TALLY_UPDATED',
  DISPUTE_VOTING_STARTED: 'DISPUTE_VOTING_STARTED',
  DISPUTE_FINALIZED: 'DISPUTE_FINALIZED',
  EVIDENCE_SIGNED: 'EVIDENCE_SIGNED',
  EXECUTION_TRIGGERED: 'EXECUTION_TRIGGERED',
  EXECUTION_COMPLETED: 'EXECUTION_COMPLETED',
  EXECUTION_FAILED: 'EXECUTION_FAILED'
};

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

export async function queueDisputeEvent(tx, { disputeId, escrowId, type, payload }) {
  if (!tx || typeof tx.disputeEvent?.create !== 'function') {
    throw new Error('queueDisputeEvent requires a Prisma transaction client');
  }
  if (!disputeId || !escrowId || !type) {
    throw new Error('disputeId, escrowId, and type are required');
  }

  return tx.disputeEvent.create({
    data: {
      disputeId,
      escrowId,
      type,
      payload: normalizePayload(payload)
    }
  });
}

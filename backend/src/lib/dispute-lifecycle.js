const MS_PER_HOUR = 60 * 60 * 1000;

function readDurationHours(envName, fallbackHours) {
  const rawValue = Number(process.env[envName]);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return fallbackHours;
  }
  return Math.floor(rawValue);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const DISPUTE_OPEN_ACK_HOURS = readDurationHours('DISPUTE_OPEN_ACK_HOURS', 24);
export const DISPUTE_EVIDENCE_WINDOW_HOURS = readDurationHours('DISPUTE_EVIDENCE_WINDOW_HOURS', 72);
export const DISPUTE_REVIEW_WINDOW_HOURS = readDurationHours('DISPUTE_REVIEW_WINDOW_HOURS', 48);
export const DISPUTE_DECISION_GRACE_HOURS = readDurationHours('DISPUTE_DECISION_GRACE_HOURS', 12);

export const DISPUTE_PHASES = Object.freeze({
  OPENED: 'OPENED',
  EVIDENCE_WINDOW: 'EVIDENCE_WINDOW',
  REVIEW_WINDOW: 'REVIEW_WINDOW',
  DECISION_PENDING: 'DECISION_PENDING',
  RESOLVED: 'RESOLVED'
});

export const DISPUTE_EVIDENCE_UPLOAD_PHASES = new Set([
  DISPUTE_PHASES.OPENED,
  DISPUTE_PHASES.EVIDENCE_WINDOW
]);

export function addHours(date, hours) {
  const baseDate = toDate(date);
  if (!baseDate) return null;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(baseDate.getTime() + Math.floor(hours) * MS_PER_HOUR);
}

export function buildDisputeDeadlineData(openedAt) {
  const openedAtDate = toDate(openedAt);
  if (!openedAtDate) {
    return {
      evidenceDeadlineAt: null,
      reviewDeadlineAt: null,
      decisionDeadlineAt: null
    };
  }

  const evidenceDeadlineAt = addHours(openedAtDate, DISPUTE_OPEN_ACK_HOURS + DISPUTE_EVIDENCE_WINDOW_HOURS);
  const reviewDeadlineAt = addHours(
    openedAtDate,
    DISPUTE_OPEN_ACK_HOURS + DISPUTE_EVIDENCE_WINDOW_HOURS + DISPUTE_REVIEW_WINDOW_HOURS
  );
  const decisionDeadlineAt = addHours(
    openedAtDate,
    DISPUTE_OPEN_ACK_HOURS + DISPUTE_EVIDENCE_WINDOW_HOURS + DISPUTE_REVIEW_WINDOW_HOURS + DISPUTE_DECISION_GRACE_HOURS
  );

  return {
    evidenceDeadlineAt,
    reviewDeadlineAt,
    decisionDeadlineAt
  };
}

export function buildDisputeLifecycleData(currentStatus, nextStatus, now = new Date()) {
  if (nextStatus !== 'DISPUTED' || currentStatus === 'DISPUTED') {
    return {};
  }

  const openedAt = toDate(now) ?? new Date();
  const deadlines = buildDisputeDeadlineData(openedAt);

  return {
    disputePhase: DISPUTE_PHASES.OPENED,
    disputeOpenedAt: openedAt,
    ...deadlines
  };
}

export function resolveNextDisputePhase(escrow, now = new Date()) {
  if (!escrow || escrow.status !== 'DISPUTED') return null;

  const currentTime = toDate(now) ?? new Date();
  const phase = escrow.disputePhase;

  if (!phase) {
    return {
      nextPhase: DISPUTE_PHASES.OPENED,
      reason: 'dispute phase initialized'
    };
  }

  if (phase === DISPUTE_PHASES.OPENED) {
    const openedAt = toDate(escrow.disputeOpenedAt);
    if (!openedAt) {
      console.error('[dispute-lifecycle] Invalid OPENED phase data: missing disputeOpenedAt', {
        escrowId: escrow.id || null,
        disputeOpenedAt: escrow.disputeOpenedAt || null
      });
      return {
        nextPhase: null,
        error: 'missing_disputeOpenedAt'
      };
    }

    const openAckDeadline = addHours(openedAt, DISPUTE_OPEN_ACK_HOURS);
    if (!openAckDeadline) {
      console.error('[dispute-lifecycle] Invalid OPENED phase data: failed to compute openAckDeadline', {
        escrowId: escrow.id || null,
        disputeOpenedAt: openedAt.toISOString(),
        openAckHours: DISPUTE_OPEN_ACK_HOURS
      });
      return {
        nextPhase: null,
        error: 'invalid_open_ack_deadline'
      };
    }

    if (openAckDeadline <= currentTime) {
      return {
        nextPhase: DISPUTE_PHASES.EVIDENCE_WINDOW,
        reason: 'opened acknowledgment elapsed'
      };
    }
    return null;
  }

  if (phase === DISPUTE_PHASES.EVIDENCE_WINDOW) {
    const evidenceDeadlineAt = toDate(escrow.evidenceDeadlineAt);
    if (evidenceDeadlineAt && evidenceDeadlineAt <= currentTime) {
      return {
        nextPhase: DISPUTE_PHASES.REVIEW_WINDOW,
        reason: 'evidence window elapsed'
      };
    }
    return null;
  }

  if (phase === DISPUTE_PHASES.REVIEW_WINDOW) {
    const reviewDeadlineAt = toDate(escrow.reviewDeadlineAt);
    if (reviewDeadlineAt && reviewDeadlineAt <= currentTime) {
      return {
        nextPhase: DISPUTE_PHASES.DECISION_PENDING,
        reason: 'review window elapsed'
      };
    }
    return null;
  }

  if (phase === DISPUTE_PHASES.DECISION_PENDING) {
    const decisionDeadlineAt = toDate(escrow.decisionDeadlineAt);
    if (decisionDeadlineAt && decisionDeadlineAt <= currentTime) {
      return {
        nextPhase: DISPUTE_PHASES.RESOLVED,
        reason: 'decision grace elapsed'
      };
    }
    return null;
  }

  return null;
}
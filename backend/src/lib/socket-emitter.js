/**
 * Helper to emit socket events from route handlers.
 * Usage: import { getIO } from './socket-emitter.js';
 *        getIO().to(escrowId).emit('event_name', data);
 */

let ioInstance = null;
const queuedEvents = [];

export function setIO(io) {
  ioInstance = io;
  // Flush queued events when IO becomes available
  if (ioInstance && queuedEvents.length > 0) {
    try {
      for (const ev of queuedEvents) {
        ioInstance.to(ev.escrowId).emit(ev.eventName, ev.data);
      }
      queuedEvents.length = 0;
      console.info('[Socket] Flushed queued events after IO initialization');
    } catch (err) {
      console.error('[Socket] Failed to flush queued events:', err?.message || err);
    }
  }
}

export function getIO() {
  return ioInstance;
}

export function emitToRoom(room, eventName, data) {
  if (!ioInstance) {
    console.warn('[Socket] IO not initialized, skipping room event:', eventName);
    return;
  }

  try {
    ioInstance.to(room).emit(eventName, data);
  } catch (err) {
    console.error('[Socket] Failed to emit room event:', eventName, err?.message || err);
  }
}

export function emitToEscrow(escrowId, eventName, data) {
  if (!ioInstance) {
    console.warn('[Socket] IO not initialized, queueing event:', eventName);
    // Queue and return so DB writes can continue; will be flushed when IO is set
    queuedEvents.push({ escrowId, eventName, data });
    return;
  }
  try {
    ioInstance.to(escrowId).emit(eventName, data);
  } catch (err) {
    console.error('[Socket] Failed to emit event:', eventName, err?.message || err);
  }
}

export function emitDisputeCreated(escrowId, payload) {
  emitToEscrow(escrowId, 'dispute-created', payload);
}

export function emitMediatorAssigned(escrowId, payload) {
  emitToEscrow(escrowId, 'mediator-assigned', payload);
}

export function emitMediatorAccepted(escrowId, payload) {
  emitToEscrow(escrowId, 'mediator-accepted', payload);
}

export function emitMediatorDeclined(escrowId, payload) {
  emitToEscrow(escrowId, 'mediator-declined', payload);
}

export function emitVoteSubmitted(escrowId, payload) {
  emitToEscrow(escrowId, 'vote-submitted', payload);
}

export function emitVoteTallyUpdated(escrowId, payload) {
  emitToEscrow(escrowId, 'vote-tally-updated', payload);
}

export function emitDisputeFinalized(escrowId, payload) {
  emitToEscrow(escrowId, 'dispute-finalized', payload);
}

export function emitEvidenceSigned(escrowId, payload) {
  emitToEscrow(escrowId, 'evidence-signed', payload);
}

// Execution events
export function emitExecutionTriggered(escrowId, payload) {
  emitToEscrow(escrowId, 'execution-triggered', payload);
}

export function emitExecutionCompleted(escrowId, payload) {
  emitToEscrow(escrowId, 'execution-completed', payload);
}

export function emitExecutionFailed(escrowId, payload) {
  emitToEscrow(escrowId, 'execution-failed', payload);
}
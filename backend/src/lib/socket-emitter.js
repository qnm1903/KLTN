/**
 * Helper to emit socket events from route handlers.
 * Usage: import { getIO } from './socket-emitter.js';
 *        getIO().to(escrowId).emit('event_name', data);
 */

let ioInstance = null;

export function setIO(io) {
  ioInstance = io;
}

export function getIO() {
  return ioInstance;
}

export function emitToEscrow(escrowId, eventName, data) {
  if (!ioInstance) {
    console.warn('[Socket] IO not initialized, cannot emit event:', eventName);
    return;
  }
  ioInstance.to(escrowId).emit(eventName, data);
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
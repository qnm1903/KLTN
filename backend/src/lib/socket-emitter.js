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
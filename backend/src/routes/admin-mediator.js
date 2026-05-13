import express from 'express';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { emitToRoom } from '../lib/socket-emitter.js';
import { ServiceError, resolveSlashAppeal } from '../services/mediator-reputation-service.js';

const router = express.Router();

function handleError(res, error, fallbackMessage) {
  if (error instanceof ServiceError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error('[Admin Mediator Route Error]:', error);
  return res.status(500).json({ error: fallbackMessage || error.message || 'Internal server error' });
}

/**
 * @route   POST /api/admin/mediator/:address/appeal/:slashId/accept
 * @desc    Accept slash appeal and cancel pending slash
 * @access  Private (admin only)
 */
router.post('/:address/appeal/:slashId/accept', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const { address, slashId } = req.params;
    const { resolutionNote } = req.body || {};

    const updated = await resolveSlashAppeal({
      address,
      slashId,
      action: 'accept',
      resolvedBy: req.user?.id,
      resolutionNote
    });

    emitToRoom(`mediator:${updated.mediatorAddress}`, 'mediator:slash-updated', {
      id: updated.id,
      mediatorAddress: updated.mediatorAddress,
      status: updated.status,
      resolvedAt: updated.resolvedAt
    });

    return res.json({ id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt });
  } catch (error) {
    return handleError(res, error, 'Failed to accept appeal');
  }
});

/**
 * @route   POST /api/admin/mediator/:address/appeal/:slashId/reject
 * @desc    Reject slash appeal and finalize pending slash
 * @access  Private (admin only)
 */
router.post('/:address/appeal/:slashId/reject', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const { address, slashId } = req.params;
    const { resolutionNote } = req.body || {};

    const updated = await resolveSlashAppeal({
      address,
      slashId,
      action: 'reject',
      resolvedBy: req.user?.id,
      resolutionNote
    });

    emitToRoom(`mediator:${updated.mediatorAddress}`, 'mediator:slash-updated', {
      id: updated.id,
      mediatorAddress: updated.mediatorAddress,
      status: updated.status,
      resolvedAt: updated.resolvedAt
    });

    return res.json({ id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt });
  } catch (error) {
    return handleError(res, error, 'Failed to reject appeal');
  }
});

export default router;

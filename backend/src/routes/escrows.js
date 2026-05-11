import express from 'express';
import prisma from '../lib/prisma.js';
import { ethers } from 'ethers';
import { authMiddleware } from '../middleware/auth.js';
import { canTransitionStatus, normalizeEscrowStatus } from '../lib/escrow-status.js';
import { buildDisputeLifecycleData, DISPUTE_PHASES } from '../lib/dispute-lifecycle.js';

const router = express.Router();

const MEDIATOR_COMMITTEE_SIZE = 5;

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMediatorAddresses(mediatorAddresses) {
  if (!Array.isArray(mediatorAddresses) || mediatorAddresses.length !== MEDIATOR_COMMITTEE_SIZE) {
    return null;
  }
  return mediatorAddresses.map((address) => normalizeAddress(address));
}

function mediatorCommitteeIncludes(escrow, userId) {
  return Array.isArray(escrow?.escrowMediators) && escrow.escrowMediators.some((row) => row.mediatorId === userId);
}

function isEscrowParticipant(escrow, userId) {
  if (!escrow || !userId) return false;
  if (escrow.buyerId === userId || escrow.sellerId === userId) return true;
  return mediatorCommitteeIncludes(escrow, userId);
}

function getParticipantRole(escrow, userId) {
  if (escrow.buyerId === userId) return 'buyer';
  if (escrow.sellerId === userId) return 'seller';
  if (mediatorCommitteeIncludes(escrow, userId)) return 'mediator';
  return null;
}

function canParticipantPatchStatus(role, nextStatus) {
  if (!role || !nextStatus) return false;

  if (nextStatus === 'INITIALIZED' || nextStatus === 'LOCKED') {
    return role === 'buyer';
  }

  if (nextStatus === 'DISPUTED') {
    return role === 'buyer' || role === 'seller';
  }

  if (nextStatus === 'RELEASED' || nextStatus === 'REFUNDED') {
    return role === 'buyer' || role === 'seller' || role === 'mediator';
  }

  return false;
}

function emitDisputeEvent(io, escrow, eventName, payload) {
  if (!io || !escrow) return;
  io.to(escrow.id).emit(eventName, payload);
  if (escrow.chainEscrowId) {
    io.to(escrow.chainEscrowId).emit(eventName, payload);
  }
}

/**
 * POST /api/escrows/draft
 * Tạo một giao dịch escrow mới ở trạng thái DRAFT (chưa deploy on-chain).
 * Body: { title, description, amount, sellerAddress, mediatorAddresses }
 */
router.post('/draft', authMiddleware, async (req, res) => {
  try {
    const { title, description, amount, sellerAddress } = req.body;

    if (!title || !amount || !sellerAddress) {
      return res.status(400).json({ error: 'title, amount, sellerAddress are required' });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const buyerAddr = req.user.walletAddress;
    const normalizedSellerAddress = normalizeAddress(sellerAddress);

    if (buyerAddr === normalizedSellerAddress) {
      return res.status(400).json({ error: 'Buyer and Seller cannot be the same address' });
    }

    // Upsert seller (create user if not exists)
    const seller = await prisma.user.upsert({
      where: { walletAddress: normalizedSellerAddress },
      update: {},
      create: { walletAddress: normalizedSellerAddress }
    });

    // Create escrow WITHOUT any escrowMediators. Mediators will be assigned by VRF during a dispute.
    const escrow = await prisma.escrow.create({
      data: {
        title,
        description: description || '',
        amount,
        buyerId: req.user.id,
        sellerId: seller.id
      },
      include: {
        buyer: { select: { id: true, walletAddress: true, name: true } },
        seller: { select: { id: true, walletAddress: true, name: true } },
        escrowMediators: {
          include: {
            mediator: { select: { id: true, walletAddress: true, name: true } }
          },
          orderBy: { slot: 'asc' }
        }
      }
    });

    res.status(201).json(escrow);
  } catch (error) {
    console.error('Error in POST /escrows/draft:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/escrows
 * Lấy danh sách escrow mà user hiện tại tham gia (buyer / seller / mediator).
 * Query: ?role=buyer|seller|mediator (optional, mặc định lấy tất cả)
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { role } = req.query;

    let where = {};
    if (role === 'buyer') {
      where = { buyerId: userId };
    } else if (role === 'seller') {
      where = { sellerId: userId };
    } else if (role === 'mediator') {
      where = { escrowMediators: { some: { mediatorId: userId } } };
    } else {
      where = {
        OR: [
          { buyerId: userId },
          { sellerId: userId },
          { escrowMediators: { some: { mediatorId: userId } } }
        ]
      };
    }

    const escrows = await prisma.escrow.findMany({
      where,
      include: {
        buyer: { select: { id: true, walletAddress: true, name: true } },
        seller: { select: { id: true, walletAddress: true, name: true } },
        escrowMediators: {
          include: {
            mediator: { select: { id: true, walletAddress: true, name: true } }
          },
          orderBy: { slot: 'asc' }
        },
        _count: { select: { evidences: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(escrows);
  } catch (error) {
    console.error('Error in GET /escrows:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/escrows/:id/status-history
 * Lấy lịch sử chuyển trạng thái để FE hiển thị timeline/audit.
 */
router.get('/:id/status-history', authMiddleware, async (req, res) => {
  try {
    const escrow = await prisma.escrow.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        buyerId: true,
        sellerId: true,
        escrowMediators: {
          select: { mediatorId: true }
        }
      }
    });

    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });

    const userId = req.user.id;
    if (!isEscrowParticipant(escrow, userId)) {
      return res.status(403).json({ error: 'You are not a participant in this escrow' });
    }

    if (!prisma.escrowStatusHistory?.findMany) {
      return res.status(501).json({ error: 'Escrow status history is not available in current runtime' });
    }

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
      : 50;

    const history = await prisma.escrowStatusHistory.findMany({
      where: { escrowId: req.params.id },
      include: {
        actor: {
          select: {
            id: true,
            walletAddress: true,
            name: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    res.json(history);
  } catch (error) {
    console.error('Error in GET /escrows/:id/status-history:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/escrows/:id
 * Lấy chi tiết một escrow. Chỉ cho phép các bên liên quan xem.
 */
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const escrow = await prisma.escrow.findUnique({
      where: { id: req.params.id },
      include: {
        buyer: { select: { id: true, walletAddress: true, name: true } },
        seller: { select: { id: true, walletAddress: true, name: true } },
        escrowMediators: {
          include: {
            mediator: { select: { id: true, walletAddress: true, name: true } }
          },
          orderBy: { slot: 'asc' }
        },
        disputes: {
          include: {
            mediators: {
              include: {
                mediator: { select: { id: true, walletAddress: true, name: true } }
              },
              orderBy: { createdAt: 'asc' }
            }
          },
          orderBy: { createdAt: 'desc' }
        },
        evidences: {
          include: {
            uploader: { select: { id: true, walletAddress: true, name: true } }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });

    // Kiểm tra quyền truy cập
    const userId = req.user.id;
    if (!isEscrowParticipant(escrow, userId)) {
      return res.status(403).json({ error: 'You are not a participant in this escrow' });
    }

    res.json(escrow);
  } catch (error) {
    console.error('Error in GET /escrows/:id:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/escrows/:id/status
 * Cập nhật status (khi on-chain transaction confirm).
 * Body: { status, chainEscrowId?, contractAddress? }
 */
router.patch('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status, chainEscrowId, contractAddress, pkAggBsX, pkAggBsY, pkAggBmX, pkAggBmY, pkAggSmX, pkAggSmY, reason } = req.body;
    const isProvided = (value) => value !== undefined && value !== null;
    // Normalize chainEscrowId if caller provided a UUID string — convert to bytes32
    const normalizedChainEscrowId = isProvided(chainEscrowId)
      ? (ethers.isBytesLike(chainEscrowId) ? chainEscrowId : ethers.keccak256(ethers.toUtf8Bytes(chainEscrowId)))
      : undefined;
    const enforceStatusTransitions = String(process.env.ENFORCE_ESCROW_STATUS_TRANSITIONS || 'true').toLowerCase() === 'true';
    const allowParticipantTerminalPatch = String(process.env.ALLOW_PARTICIPANT_TERMINAL_STATUS_PATCH || 'false').toLowerCase() === 'true';
    const nextStatus = status ? normalizeEscrowStatus(status) : null;

    if (status && !nextStatus) {
      return res.status(400).json({ error: 'Invalid escrow status' });
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const escrow = await tx.escrow.findUnique({
        where: { id: req.params.id },
        include: {
          escrowMediators: {
            select: { mediatorId: true }
          }
        }
      });
      if (!escrow) {
        const notFoundError = new Error('Escrow not found');
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const userId = req.user.id;
      if (!isEscrowParticipant(escrow, userId)) {
        const forbiddenError = new Error('You are not a participant in this escrow');
        forbiddenError.statusCode = 403;
        throw forbiddenError;
      }

      const participantRole = getParticipantRole(escrow, userId);
      if (nextStatus) {
        if (!canParticipantPatchStatus(participantRole, nextStatus)) {
          const roleError = new Error(`Role '${participantRole}' cannot set escrow status to '${nextStatus}'`);
          roleError.statusCode = 403;
          throw roleError;
        }

        if (enforceStatusTransitions && !canTransitionStatus(escrow.status, nextStatus)) {
          const transitionError = new Error(`Invalid status transition from ${escrow.status} to ${nextStatus}`);
          transitionError.statusCode = 409;
          throw transitionError;
        }
      }

      const updateData = {};
      if (nextStatus) updateData.status = nextStatus;
      if (isProvided(chainEscrowId)) updateData.chainEscrowId = normalizedChainEscrowId;
      if (isProvided(contractAddress)) updateData.contractAddress = contractAddress;
      if (isProvided(pkAggBsX)) updateData.pkAggBsX = pkAggBsX;
      if (isProvided(pkAggBsY)) updateData.pkAggBsY = pkAggBsY;
      if (isProvided(pkAggBmX)) updateData.pkAggBmX = pkAggBmX;
      if (isProvided(pkAggBmY)) updateData.pkAggBmY = pkAggBmY;
      if (isProvided(pkAggSmX)) updateData.pkAggSmX = pkAggSmX;
      if (isProvided(pkAggSmY)) updateData.pkAggSmY = pkAggSmY;

      if (nextStatus) {
        Object.assign(updateData, buildDisputeLifecycleData(escrow.status, nextStatus, new Date()));

        if (
          (nextStatus === 'RELEASED' || nextStatus === 'REFUNDED') &&
          escrow.status === 'DISPUTED'
        ) {
          updateData.disputePhase = DISPUTE_PHASES.RESOLVED;
        }
      }

      if (nextStatus) {
        const guarded = await tx.escrow.updateMany({
          where: {
            id: req.params.id,
            status: escrow.status
          },
          data: updateData
        });

        if (guarded.count !== 1) {
          const conflictError = new Error('Escrow was updated by another request. Please retry.');
          conflictError.statusCode = 409;
          throw conflictError;
        }
      } else {
        await tx.escrow.update({
          where: { id: req.params.id },
          data: updateData
        });
      }

      if (nextStatus && nextStatus !== escrow.status) {
        if (!tx.escrowStatusHistory?.create) {
          const historyUnavailableError = new Error('escrowStatusHistory model not available');
          historyUnavailableError.statusCode = 501;
          throw historyUnavailableError;
        }

        await tx.escrowStatusHistory.create({
          data: {
            escrowId: escrow.id,
            actorUserId: userId,
            source: 'API',
            fromStatus: escrow.status,
            toStatus: nextStatus,
            reason: reason || null,
            metadata: {
              participantRole,
              chainEscrowId: isProvided(chainEscrowId) ? normalizedChainEscrowId : null,
              contractAddress: isProvided(contractAddress) ? contractAddress : null
            }
          }
        });
      }

      const updatedEscrow = await tx.escrow.findUnique({ where: { id: req.params.id } });
      return {
        updatedEscrow,
        previousStatus: escrow.status,
        appliedStatus: nextStatus
      };
    });

    const updated = txResult.updatedEscrow;
    const previousStatus = txResult.previousStatus;
    const appliedStatus = txResult.appliedStatus;

    const io = req.app.get('io');
    if (appliedStatus && appliedStatus !== previousStatus) {
      const basePayload = {
        escrowId: updated.id,
        chainEscrowId: updated.chainEscrowId,
        status: updated.status,
        disputePhase: updated.disputePhase || null,
        actorUserId: req.user.id,
        updatedAt: updated.updatedAt
      };

      if (appliedStatus === 'DISPUTED') {
        emitDisputeEvent(io, updated, 'dispute-opened', basePayload);
        emitDisputeEvent(io, updated, 'dispute-phase-changed', basePayload);
      } else if ((appliedStatus === 'RELEASED' || appliedStatus === 'REFUNDED') && previousStatus === 'DISPUTED') {
        emitDisputeEvent(io, updated, 'dispute-resolved', {
          ...basePayload,
          finalStatus: appliedStatus
        });
      }
    }

    res.json(updated);
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Error in PATCH /escrows/:id/status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
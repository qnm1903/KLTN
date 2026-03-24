import express from 'express';
import prisma from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { canTransitionStatus, normalizeEscrowStatus } from '../lib/escrow-status.js';

const router = express.Router();

/**
 * POST /api/escrows/draft
 * Tạo một giao dịch escrow mới ở trạng thái DRAFT (chưa deploy on-chain).
 * Body: { title, description, amount, sellerAddress, mediatorAddress }
 */
router.post('/draft', authMiddleware, async (req, res) => {
  try {
    const { title, description, amount, sellerAddress, mediatorAddress } = req.body;

    if (!title || !amount || !sellerAddress || !mediatorAddress) {
      return res.status(400).json({ error: 'title, amount, sellerAddress, mediatorAddress are required' });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const buyerAddr = req.user.walletAddress;
    if (buyerAddr === sellerAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Buyer and Seller cannot be the same address' });
    }

    // Upsert seller & mediator (tạo tài khoản nếu chưa có)
    const seller = await prisma.user.upsert({
      where: { walletAddress: sellerAddress.toLowerCase() },
      update: {},
      create: { walletAddress: sellerAddress.toLowerCase() }
    });

    const mediator = await prisma.user.upsert({
      where: { walletAddress: mediatorAddress.toLowerCase() },
      update: {},
      create: { walletAddress: mediatorAddress.toLowerCase(), role: 'MEDIATOR' }
    });

    const escrow = await prisma.escrow.create({
      data: {
        title,
        description: description || '',
        amount,
        buyerId: req.user.id,
        sellerId: seller.id,
        mediatorId: mediator.id
      },
      include: {
        buyer: { select: { id: true, walletAddress: true, name: true } },
        seller: { select: { id: true, walletAddress: true, name: true } },
        mediator: { select: { id: true, walletAddress: true, name: true } }
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
      where = { mediatorId: userId };
    } else {
      where = {
        OR: [
          { buyerId: userId },
          { sellerId: userId },
          { mediatorId: userId }
        ]
      };
    }

    const escrows = await prisma.escrow.findMany({
      where,
      include: {
        buyer: { select: { id: true, walletAddress: true, name: true } },
        seller: { select: { id: true, walletAddress: true, name: true } },
        mediator: { select: { id: true, walletAddress: true, name: true } },
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
        mediator: { select: { id: true, walletAddress: true, name: true } },
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
    if (escrow.buyerId !== userId && escrow.sellerId !== userId && escrow.mediatorId !== userId) {
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
    const { status, chainEscrowId, contractAddress, pkAggBsX, pkAggBsY, pkAggBmX, pkAggBmY, pkAggSmX, pkAggSmY } = req.body;
    const enforceStatusTransitions = String(process.env.ENFORCE_ESCROW_STATUS_TRANSITIONS || 'false').toLowerCase() === 'true';

    const escrow = await prisma.escrow.findUnique({ where: { id: req.params.id } });
    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });

    const userId = req.user.id;
    if (escrow.buyerId !== userId && escrow.sellerId !== userId && escrow.mediatorId !== userId) {
      return res.status(403).json({ error: 'You are not a participant in this escrow' });
    }

    if (status) {
      const normalizedStatus = normalizeEscrowStatus(status);
      if (!normalizedStatus) {
        return res.status(400).json({ error: 'Invalid escrow status' });
      }
      if (enforceStatusTransitions && !canTransitionStatus(escrow.status, normalizedStatus)) {
        return res.status(409).json({
          error: `Invalid status transition from ${escrow.status} to ${normalizedStatus}`
        });
      }
    }

    const updateData = {};
    if (status) updateData.status = normalizeEscrowStatus(status);
    if (chainEscrowId) updateData.chainEscrowId = chainEscrowId;
    if (contractAddress) updateData.contractAddress = contractAddress;
    if (pkAggBsX) updateData.pkAggBsX = pkAggBsX;
    if (pkAggBsY) updateData.pkAggBsY = pkAggBsY;
    if (pkAggBmX) updateData.pkAggBmX = pkAggBmX;
    if (pkAggBmY) updateData.pkAggBmY = pkAggBmY;
    if (pkAggSmX) updateData.pkAggSmX = pkAggSmX;
    if (pkAggSmY) updateData.pkAggSmY = pkAggSmY;

    const updated = await prisma.escrow.update({
      where: { id: req.params.id },
      data: updateData
    });

    res.json(updated);
  } catch (error) {
    console.error('Error in PATCH /escrows/:id/status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;

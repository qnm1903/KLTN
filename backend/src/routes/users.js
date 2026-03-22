import express from 'express';
import prisma from '../lib/prisma.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/users/me
 * Lấy thông tin user hiện tại (cần JWT).
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        walletAddress: true,
        name: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            boughtEscrows: true,
            soldEscrows: true,
            mediatedEscrows: true
          }
        }
      }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Error in /users/me:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/users/me
 * Cập nhật profile (name).
 */
router.patch('/me', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name },
      select: { id: true, walletAddress: true, name: true, role: true }
    });
    res.json(user);
  } catch (error) {
    console.error('Error in PATCH /users/me:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/users/mediators
 * Lấy danh sách Mediator để buyer/seller chọn khi tạo escrow.
 */
router.get('/mediators', authMiddleware, async (req, res) => {
  try {
    const mediators = await prisma.user.findMany({
      where: { role: 'MEDIATOR' },
      select: {
        id: true,
        walletAddress: true,
        name: true,
        _count: { select: { mediatedEscrows: true } }
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json(mediators);
  } catch (error) {
    console.error('Error in /users/mediators:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/users/:id/role (ADMIN only)
 * Nâng cấp role cho user (VD: USER → MEDIATOR).
 */
router.patch('/:id/role', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!['USER', 'MEDIATOR', 'ADMIN'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      select: { id: true, walletAddress: true, name: true, role: true }
    });
    res.json(user);
  } catch (error) {
    console.error('Error in PATCH /users/:id/role:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;

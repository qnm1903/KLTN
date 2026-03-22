import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình lưu file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.mp4', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  }
});

const router = express.Router();

/**
 * POST /api/escrows/:id/evidence
 * Upload bằng chứng cho giao dịch (trong tranh chấp).
 * Form-data: file + description
 */
router.post('/:id/evidence', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const escrowId = req.params.id;
    const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });

    // Chỉ các bên liên quan mới được upload
    const userId = req.user.id;
    if (escrow.buyerId !== userId && escrow.sellerId !== userId && escrow.mediatorId !== userId) {
      return res.status(403).json({ error: 'You are not a participant in this escrow' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const evidence = await prisma.evidence.create({
      data: {
        escrowId,
        uploaderId: userId,
        fileUrl: `/uploads/${req.file.filename}`,
        description: req.body.description || ''
      },
      include: {
        uploader: { select: { id: true, walletAddress: true, name: true } }
      }
    });

    res.status(201).json(evidence);
  } catch (error) {
    console.error('Error in POST /evidence:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/escrows/:id/evidences
 * Xem danh sách bằng chứng của giao dịch.
 */
router.get('/:id/evidences', authMiddleware, async (req, res) => {
  try {
    const escrowId = req.params.id;
    const escrow = await prisma.escrow.findUnique({ where: { id: escrowId } });
    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });

    const userId = req.user.id;
    if (escrow.buyerId !== userId && escrow.sellerId !== userId && escrow.mediatorId !== userId) {
      return res.status(403).json({ error: 'You are not a participant in this escrow' });
    }

    const evidences = await prisma.evidence.findMany({
      where: { escrowId },
      include: {
        uploader: { select: { id: true, walletAddress: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(evidences);
  } catch (error) {
    console.error('Error in GET /evidences:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
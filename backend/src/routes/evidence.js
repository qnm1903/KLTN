import express from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { DISPUTE_EVIDENCE_UPLOAD_PHASES } from '../lib/dispute-lifecycle.js';
import { uploadEvidenceToIpfs } from '../lib/ipfs-storage.js';
import { calculateMerkleRoot } from '../lib/merkle.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = {
      '.jpg': ['image/jpeg', 'image/jpg'],
      '.jpeg': ['image/jpeg', 'image/jpg'],
      '.png': ['image/png'],
      '.gif': ['image/gif'],
      '.pdf': ['application/pdf'],
      '.mp4': ['video/mp4'],
      '.webm': ['video/webm']
    };
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    if (allowed[ext] && allowed[ext].includes(mime)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} (${mime || 'unknown'}) not allowed`));
    }
  }
});

function handleEvidenceUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File exceeds 10MB limit' });
    }

    return res.status(400).json({ error: error.message || 'Invalid file upload' });
  });
}

const router = express.Router();

function isEscrowParticipant(escrow, userId) {
  if (!escrow || !userId) return false;
  if (escrow.buyerId === userId || escrow.sellerId === userId) return true;
  return Array.isArray(escrow.escrowMediators) && escrow.escrowMediators.some((row) => row.mediatorId === userId);
}

function isEvidenceUploadAllowed(escrow, now = new Date()) {
  if (escrow.status !== 'DISPUTED') {
    return {
      ok: false,
      error: 'Evidence upload is only allowed when escrow is DISPUTED'
    };
  }

  if (escrow.disputePhase && !DISPUTE_EVIDENCE_UPLOAD_PHASES.has(escrow.disputePhase)) {
    return {
      ok: false,
      error: `Evidence upload is closed in dispute phase '${escrow.disputePhase}'`
    };
  }

  if (escrow.evidenceDeadlineAt) {
    const evidenceDeadlineAt = new Date(escrow.evidenceDeadlineAt);
    if (!Number.isNaN(evidenceDeadlineAt.getTime()) && evidenceDeadlineAt <= now) {
      return {
        ok: false,
        error: 'Evidence window has ended'
      };
    }
  }

  return { ok: true };
}

/**
 * POST /api/escrows/:id/evidence
 * Upload bằng chứng cho giao dịch (trong tranh chấp).
 * Form-data: file + description
 */
router.post('/:id/evidence', authMiddleware, handleEvidenceUpload, async (req, res) => {
  try {
    const escrowId = req.params.id;
    const escrow = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: {
        escrowMediators: {
          select: { mediatorId: true }
        }
      }
    });
    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });

    // Chỉ các bên liên quan mới được upload
    const userId = req.user.id;
    if (!isEscrowParticipant(escrow, userId)) {
      return res.status(403).json({ error: 'You are not a participant in this escrow' });
    }

    const uploadValidation = isEvidenceUploadAllowed(escrow);
    if (!uploadValidation.ok) {
      return res.status(409).json({ error: uploadValidation.error });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    let uploadedFile;
    try {
      uploadedFile = await uploadEvidenceToIpfs(req.file, {
        name: req.file.originalname,
        publicName: req.file.originalname,
        metadata: {
          escrowId,
          uploaderId: userId
        }
      });
    } catch (uploadError) {
      console.error('Error uploading evidence to IPFS:', uploadError.message);
      return res.status(502).json({ error: uploadError.message });
    }

    // Get file hash from frontend (SHA-256)
    const fileHash = req.body.fileHash;
    if (!fileHash) {
      return res.status(400).json({ error: 'fileHash is required' });
    }

    // Get all existing evidence hashes for this escrow
    const existingEvidences = await prisma.evidence.findMany({
      where: { escrowId },
      select: { fileHash: true }
    });

    // Calculate new Merkle root with new evidence
    const allHashes = [...existingEvidences.map(e => e.fileHash), fileHash];
    const merkleRoot = calculateMerkleRoot(allHashes);

    const evidence = await prisma.evidence.create({
      data: {
        escrowId,
        uploaderId: userId,
        fileUrl: uploadedFile.fileUrl,
        fileHash,
        merkleRoot,
        description: req.body.description || ''
      },
      include: {
        uploader: { select: { id: true, walletAddress: true, name: true } }
      }
    });

    const io = req.app.get('io');
    if (io) {
      const payload = {
        escrowId,
        evidenceId: evidence.id,
        uploaderId: userId,
        cid: uploadedFile.cid,
        storageProvider: uploadedFile.provider,
        fileUrl: evidence.fileUrl,
        description: evidence.description,
        createdAt: evidence.createdAt
      };
      io.to(escrowId).emit('dispute-evidence-added', payload);
      if (escrow.chainEscrowId) {
        io.to(escrow.chainEscrowId).emit('dispute-evidence-added', payload);
      }
    }

    res.status(201).json({
      evidenceId: evidence.id,
      ipfsHash: evidence.fileUrl,
      fileHash: evidence.fileHash,
      uploadedAt: evidence.createdAt?.toISOString() || null,
      uploader: evidence.uploader?.walletAddress || null,
      description: evidence.description || '',
      escrowId: evidence.escrowId
    });
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
    const escrow = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: {
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
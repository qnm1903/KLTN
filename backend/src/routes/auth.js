import express from 'express';
import { ethers } from 'ethers';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';

const router = express.Router();

// In-memory nonce store (TTL 5 phút)
const nonceStore = new Map();
const NONCE_TTL = 5 * 60 * 1000;

/**
 * GET /api/auth/nonce?address=0x...
 * Trả về nonce ngẫu nhiên để user ký bằng MetaMask.
 */
router.get('/nonce', (req, res) => {
  const { address } = req.query;
  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Valid Ethereum address required' });
  }

  const nonce = crypto.randomBytes(32).toString('hex');
  nonceStore.set(address.toLowerCase(), {
    nonce,
    expiresAt: Date.now() + NONCE_TTL
  });

  // Cleanup expired nonces mỗi lần gọi
  for (const [key, val] of nonceStore) {
    if (Date.now() > val.expiresAt) nonceStore.delete(key);
  }

  res.json({ nonce });
});

/**
 * POST /api/auth/verify
 * Body: { address, signature }
 * Verify chữ ký MetaMask (Personal Sign) → cấp JWT.
 */
router.post('/verify', async (req, res) => {
  try {
    const { address, signature } = req.body;
    if (!address || !signature) {
      return res.status(400).json({ error: 'address and signature are required' });
    }

    const addr = address.toLowerCase();
    const stored = nonceStore.get(addr);
    if (!stored) {
      return res.status(400).json({ error: 'No nonce found. Call GET /nonce first.' });
    }
    if (Date.now() > stored.expiresAt) {
      nonceStore.delete(addr);
      return res.status(400).json({ error: 'Nonce expired. Request a new one.' });
    }

    // Message giống hệt cái mà MetaMask ký ở Frontend
    const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${stored.nonce}`;

    // Recover address từ chữ ký
    const recoveredAddress = ethers.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== addr) {
      return res.status(401).json({ error: 'Signature does not match address' });
    }

    // Xóa nonce đã dùng
    nonceStore.delete(addr);

    // Upsert user trong DB
    let user = await prisma.user.findUnique({ where: { walletAddress: addr } });
    if (!user) {
      user = await prisma.user.create({
        data: { walletAddress: addr }
      });
    }

    // Cấp JWT
    const token = signToken({
      id: user.id,
      walletAddress: user.walletAddress,
      role: user.role
    });

    res.json({
      token,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Error in /auth/verify:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
import express from 'express';
import { ethers } from 'ethers';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';
import { createRouteRateLimiter, getRateLimitConfig } from '../middleware/rate-limit.js';

const router = express.Router();

const NONCE_TTL = 5 * 60 * 1000;
const { authNonceMax } = getRateLimitConfig();
const authNonceRateLimiter = createRouteRateLimiter({
  max: authNonceMax,
  message: 'Too many nonce requests. Please try again in a moment.'
});

/**
 * GET /api/auth/nonce?address=0x...
 * Trả về nonce ngẫu nhiên để user ký bằng MetaMask.
 */
router.get('/nonce', authNonceRateLimiter, async (req, res) => {
  try {
    const { address } = req.query;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ error: 'Valid Ethereum address required' });
    }

    const addr = address.toLowerCase();
    const nonce = crypto.randomBytes(32).toString('hex');

    await prisma.authNonce.upsert({
      where: { address: addr },
      update: {
        nonce,
        expiresAt: new Date(Date.now() + NONCE_TTL)
      },
      create: {
        address: addr,
        nonce,
        expiresAt: new Date(Date.now() + NONCE_TTL)
      }
    });

    // Cleanup expired nonces để giữ store gọn.
    await prisma.authNonce.deleteMany({
      where: { expiresAt: { lt: new Date() } }
    });

    res.json({ nonce });
  } catch (error) {
    console.error('Error in /auth/nonce:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    const stored = await prisma.authNonce.findUnique({ where: { address: addr } });
    if (!stored) {
      return res.status(400).json({ error: 'No nonce found. Call GET /nonce first.' });
    }

    if (Date.now() > new Date(stored.expiresAt).getTime()) {
      await prisma.authNonce.delete({ where: { address: addr } }).catch(() => undefined);
      return res.status(400).json({ error: 'Nonce expired. Request a new one.' });
    }

    // Message giống hệt cái mà MetaMask ký ở Frontend
    const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${stored.nonce}`;

    // Recover address từ chữ ký
    const recoveredAddress = ethers.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== addr) {
      return res.status(401).json({ error: 'Signature does not match address' });
    }

    // Xóa nonce theo address + nonce để tránh replay khi request song song.
    const consumeNonce = await prisma.authNonce.deleteMany({
      where: {
        address: addr,
        nonce: stored.nonce
      }
    });

    if (consumeNonce.count !== 1) {
      return res.status(400).json({ error: 'Nonce already consumed. Request a new one.' });
    }

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
import express from 'express';
import { ethers } from 'ethers';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { signToken } from '../middleware/auth.js';
import { createRouteRateLimiter, getRateLimitConfig } from '../middleware/rate-limit.js';

const router = express.Router();

const NONCE_TTL = 5 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = Number.parseInt(process.env.REFRESH_TOKEN_TTL_MS || '', 10) || 7 * 24 * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REFRESH_COOKIE_SAME_SITE = IS_PRODUCTION ? 'strict' : 'lax';
const NONCE_CLEANUP_SAMPLE_RATE = Number.parseFloat(process.env.NONCE_CLEANUP_SAMPLE_RATE || '0.05');
const { authNonceMax, authVerifyMax } = getRateLimitConfig();
const authNonceRateLimiter = createRouteRateLimiter({
  max: authNonceMax,
  message: 'Too many nonce requests. Please try again in a moment.'
});
const authVerifyRateLimiter = createRouteRateLimiter({
  max: authVerifyMax,
  message: 'Too many authentication attempts. Please try again in a moment.'
});

function buildAuthMessage(nonce) {
  return `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;
}

function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function getRefreshCookieOptions(maxAge = REFRESH_TOKEN_TTL_MS) {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: REFRESH_COOKIE_SAME_SITE,
    path: '/api/auth',
    maxAge,
  };
}

function setRefreshCookie(res, refreshToken, maxAge = REFRESH_TOKEN_TTL_MS) {
  res.cookie('refresh_token', refreshToken, getRefreshCookieOptions(maxAge));
}

function clearRefreshCookie(res) {
  res.clearCookie('refresh_token', getRefreshCookieOptions(0));
}

function getRefreshTokenFromCookie(req) {
  return req.cookies?.['refresh_token'] || null;
}

function isPrismaTimeoutError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return error?.code === 'P1008' || message.includes('operation has timed out');
}

async function withPrismaTimeoutRetry(task, maxAttempts = 5, baseDelayMs = 500) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isPrismaTimeoutError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delay = baseDelayMs * attempt;
      console.warn(`[Prisma Retry] Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function issueSessionTokens(user) {
  const accessToken = signToken({
    id: user.id,
    walletAddress: user.walletAddress,
    role: user.role
  });

  const refreshToken = crypto.randomBytes(48).toString('hex');
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      expiresAt: refreshTokenExpiresAt
    }
  });

  await prisma.refreshToken.deleteMany({
    where: {
      userId: user.id,
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { not: null } }
      ]
    }
  });

  return {
    token: accessToken,
    accessToken,
    refreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    refreshTokenMaxAge: REFRESH_TOKEN_TTL_MS,
  };
}

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

    await withPrismaTimeoutRetry(() => prisma.authNonce.upsert({
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
    }));

    // Opportunistic cleanup to avoid writing on every nonce request.
    if (Math.random() < NONCE_CLEANUP_SAMPLE_RATE) {
      withPrismaTimeoutRetry(() => prisma.authNonce.deleteMany({
        where: { expiresAt: { lt: new Date() } }
      }))
        .catch((cleanupError) => {
          console.warn('Auth nonce cleanup skipped due to transient DB error:', cleanupError?.message || cleanupError);
        });
    }

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
router.post('/verify', authVerifyRateLimiter, async (req, res) => {
  try {
    const { address, signature } = req.body;
    if (!address || !signature) {
      return res.status(400).json({ error: 'address and signature are required' });
    }
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: 'Valid Ethereum address required' });
    }

    try {
      ethers.Signature.from(signature);
    } catch {
      return res.status(400).json({ error: 'Invalid signature format' });
    }

    const addr = address.toLowerCase();
    const stored = await withPrismaTimeoutRetry(() => prisma.authNonce.findUnique({ where: { address: addr } }));
    if (!stored) {
      return res.status(400).json({ error: 'No nonce found. Call GET /nonce first.' });
    }

    if (Date.now() > new Date(stored.expiresAt).getTime()) {
      await prisma.authNonce.delete({ where: { address: addr } }).catch(() => undefined);
      return res.status(400).json({ error: 'Nonce expired. Request a new one.' });
    }

    // Message giống hệt cái mà MetaMask ký ở Frontend
    const message = buildAuthMessage(stored.nonce);

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

    const sessionTokens = await issueSessionTokens(user);

    setRefreshCookie(res, sessionTokens.refreshToken, sessionTokens.refreshTokenMaxAge);

    res.json({
      token: sessionTokens.accessToken,
      accessToken: sessionTokens.accessToken,
      refreshTokenExpiresAt: sessionTokens.refreshTokenExpiresAt,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Error in /auth/verify:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/refresh', authVerifyRateLimiter, async (req, res) => {
  try {
    const refreshToken = getRefreshTokenFromCookie(req);
    if (!refreshToken) {
      return res.status(401).json({ error: 'Missing refresh token cookie' });
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            walletAddress: true,
            name: true,
            role: true
          }
        }
      }
    });

    if (!stored || stored.revokedAt || stored.expiresAt.getTime() <= Date.now() || !stored.user) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const nextRefreshToken = crypto.randomBytes(48).toString('hex');
    const nextRefreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() }
    });

    await prisma.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken(nextRefreshToken),
        userId: stored.user.id,
        expiresAt: nextRefreshTokenExpiresAt
      }
    });

    const accessToken = signToken({
      id: stored.user.id,
      walletAddress: stored.user.walletAddress,
      role: stored.user.role
    });

    setRefreshCookie(res, nextRefreshToken, REFRESH_TOKEN_TTL_MS);

    return res.json({
      token: accessToken,
      accessToken,
      refreshTokenExpiresAt: nextRefreshTokenExpiresAt.toISOString(),
      user: stored.user
    });
  } catch (error) {
    console.error('Error in /auth/refresh:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', authVerifyRateLimiter, async (req, res) => {
  try {
    const refreshToken = getRefreshTokenFromCookie(req);

    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: {
          tokenHash: hashRefreshToken(refreshToken),
          revokedAt: null
        },
        data: {
          revokedAt: new Date()
        }
      });
    }

    clearRefreshCookie(res);

    return res.json({ ok: true });
  } catch (error) {
    console.error('Error in /auth/logout:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
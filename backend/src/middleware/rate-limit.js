import rateLimit from 'express-rate-limit';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);

export function createRouteRateLimiter({ max, message }) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Too many requests. Please try again later.' }
  });
}

export function getRateLimitConfig() {
  return {
    authNonceMax: parsePositiveInt(process.env.RATE_LIMIT_AUTH_NONCE_MAX, 20),
    authVerifyMax: parsePositiveInt(process.env.RATE_LIMIT_AUTH_VERIFY_MAX, 15),
    escrowInitMax: parsePositiveInt(process.env.RATE_LIMIT_ESCROW_INIT_MAX, 10),
    escrowSignMax: parsePositiveInt(process.env.RATE_LIMIT_ESCROW_SIGN_MAX, 20)
  };
}
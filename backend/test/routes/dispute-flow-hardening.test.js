import request from 'supertest';
import express from 'express';
import { jest } from '@jest/globals';
import { sessions } from '../../src/store/session.js';
import { signToken } from '../../src/middleware/auth.js';

const mockPrisma = {
  escrow: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  evidence: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  user: {
    upsert: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn()
  }
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: mockPrisma
}));

const { default: escrowsRouter } = await import('../../src/routes/escrows.js');
const { default: evidenceRouter } = await import('../../src/routes/evidence.js');

function authHeader(user) {
  return `Bearer ${signToken(user)}`;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/escrows', escrowsRouter);
  app.use('/api/escrows', evidenceRouter);
  return app;
}

describe('Dispute flow hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessions.clear();
    delete process.env.ENFORCE_ESCROW_STATUS_TRANSITIONS;
    delete process.env.ALLOW_PARTICIPANT_TERMINAL_STATUS_PATCH;
  });

  it('enforces status transition checks by default', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-1',
      status: 'DRAFT',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });

    const res = await request(app)
      .patch('/api/escrows/escrow-1/status')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .send({ status: 'DISPUTED' });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/invalid status transition/i);
    expect(mockPrisma.escrow.update).not.toHaveBeenCalled();
  });

  it('blocks participant from setting terminal status by default', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-2',
      status: 'LOCKED',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });

    const res = await request(app)
      .patch('/api/escrows/escrow-2/status')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .send({ status: 'RELEASED' });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/cannot set escrow status/i);
    expect(mockPrisma.escrow.update).not.toHaveBeenCalled();
  });

  it('allows terminal status patch only when explicit env override is enabled', async () => {
    process.env.ALLOW_PARTICIPANT_TERMINAL_STATUS_PATCH = 'true';

    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-3',
      status: 'LOCKED',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });
    mockPrisma.escrow.update.mockResolvedValue({ id: 'escrow-3', status: 'RELEASED' });

    const res = await request(app)
      .patch('/api/escrows/escrow-3/status')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .send({ status: 'RELEASED' });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('RELEASED');
    expect(mockPrisma.escrow.update).toHaveBeenCalledTimes(1);
  });

  it('rejects evidence upload unless escrow is DISPUTED', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-4',
      status: 'LOCKED',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });

    const res = await request(app)
      .post('/api/escrows/escrow-4/evidence')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .field('description', 'evidence before dispute');

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/only allowed when escrow is DISPUTED/i);
    expect(mockPrisma.evidence.create).not.toHaveBeenCalled();
  });

});

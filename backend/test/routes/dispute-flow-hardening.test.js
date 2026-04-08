import request from 'supertest';
import express from 'express';
import { jest } from '@jest/globals';
import { clearSessions } from '../../src/store/session.js';
import { signToken } from '../../src/middleware/auth.js';

const mockPrisma = {
  escrow: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  escrowStatusHistory: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  evidence: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  user: {
    upsert: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn()
  },
  $transaction: jest.fn()
};

mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: mockPrisma
}));

const mockUploadEvidenceToIpfs = jest.fn();

jest.unstable_mockModule('../../src/lib/ipfs-storage.js', () => ({
  uploadEvidenceToIpfs: mockUploadEvidenceToIpfs
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
  beforeEach(async () => {
    jest.clearAllMocks();
    mockUploadEvidenceToIpfs.mockResolvedValue({
      cid: 'bafy-test-cid',
      fileUrl: 'https://gateway.pinata.cloud/ipfs/bafy-test-cid?filename=evidence.txt',
      provider: 'pinata'
    });
    await clearSessions();
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
    expect(mockPrisma.escrow.updateMany).not.toHaveBeenCalled();
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
    expect(mockPrisma.escrow.updateMany).not.toHaveBeenCalled();
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
    mockPrisma.escrow.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.escrow.findUnique
      .mockResolvedValueOnce({
        id: 'escrow-3',
        status: 'LOCKED',
        buyerId: 'user-1',
        sellerId: 'user-2',
        mediatorId: 'user-3'
      })
      .mockResolvedValueOnce({ id: 'escrow-3', status: 'RELEASED' });

    const res = await request(app)
      .patch('/api/escrows/escrow-3/status')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .send({ status: 'RELEASED' });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('RELEASED');
    expect(mockPrisma.escrow.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.escrowStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when optimistic guard detects stale write', async () => {
    process.env.ALLOW_PARTICIPANT_TERMINAL_STATUS_PATCH = 'true';

    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-5',
      status: 'LOCKED',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });
    mockPrisma.escrow.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/escrows/escrow-5/status')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .send({ status: 'RELEASED' });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/updated by another request/i);
    expect(mockPrisma.escrowStatusHistory.create).not.toHaveBeenCalled();
  });

  it('records dispute lifecycle fields when transitioning into DISPUTED', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique
      .mockResolvedValueOnce({
        id: 'escrow-6',
        status: 'LOCKED',
        buyerId: 'user-1',
        sellerId: 'user-2',
        mediatorId: 'user-3'
      })
      .mockResolvedValueOnce({ id: 'escrow-6', status: 'DISPUTED', disputePhase: 'OPENED' });
    mockPrisma.escrow.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/escrows/escrow-6/status')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .send({ status: 'DISPUTED', reason: 'buyer opened dispute' });

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.escrow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DISPUTED',
          disputePhase: 'OPENED',
          disputeOpenedAt: expect.any(Date),
          evidenceDeadlineAt: expect.any(Date),
          reviewDeadlineAt: expect.any(Date),
          decisionDeadlineAt: expect.any(Date)
        })
      })
    );
    expect(mockPrisma.escrowStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'API',
          fromStatus: 'LOCKED',
          toStatus: 'DISPUTED',
          reason: 'buyer opened dispute'
        })
      })
    );
  });

  it('marks dispute phase RESOLVED when closing a disputed escrow', async () => {
    process.env.ALLOW_PARTICIPANT_TERMINAL_STATUS_PATCH = 'true';

    const app = buildApp();
    mockPrisma.escrow.findUnique
      .mockResolvedValueOnce({
        id: 'escrow-7',
        status: 'DISPUTED',
        disputePhase: 'DECISION_PENDING',
        buyerId: 'user-1',
        sellerId: 'user-2',
        mediatorId: 'user-3'
      })
      .mockResolvedValueOnce({ id: 'escrow-7', status: 'RELEASED', disputePhase: 'RESOLVED' });
    mockPrisma.escrow.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/escrows/escrow-7/status')
      .set('Authorization', authHeader({ id: 'user-3', walletAddress: '0x3', role: 'MEDIATOR' }))
      .send({ status: 'RELEASED', reason: 'mediator decision' });

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.escrow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RELEASED',
          disputePhase: 'RESOLVED'
        })
      })
    );
    expect(mockPrisma.escrowStatusHistory.create).toHaveBeenCalledTimes(1);
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

  it('rejects evidence upload outside evidence-allowed phases', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-8',
      status: 'DISPUTED',
      disputePhase: 'REVIEW_WINDOW',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });

    const res = await request(app)
      .post('/api/escrows/escrow-8/evidence')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .field('description', 'late evidence');

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/closed in dispute phase/i);
    expect(mockPrisma.evidence.create).not.toHaveBeenCalled();
  });

  it('rejects evidence upload after evidence deadline', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-9',
      status: 'DISPUTED',
      disputePhase: 'EVIDENCE_WINDOW',
      evidenceDeadlineAt: new Date('2025-01-01T00:00:00.000Z'),
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });

    const res = await request(app)
      .post('/api/escrows/escrow-9/evidence')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .field('description', 'late evidence by deadline');

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/evidence window has ended/i);
    expect(mockPrisma.evidence.create).not.toHaveBeenCalled();
  });

  it('uploads evidence to IPFS and stores the gateway URL', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-11',
      status: 'DISPUTED',
      disputePhase: 'EVIDENCE_WINDOW',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3',
      chainEscrowId: '0xabc123'
    });
    mockPrisma.evidence.create.mockResolvedValue({
      id: 'evidence-11',
      escrowId: 'escrow-11',
      uploaderId: 'user-1',
      fileUrl: 'https://gateway.pinata.cloud/ipfs/bafy-test-cid?filename=evidence.txt',
      description: 'ipfs evidence',
      createdAt: new Date('2026-04-08T00:00:00.000Z'),
      uploader: { id: 'user-1', walletAddress: '0x1', name: 'Buyer' }
    });

    const res = await request(app)
      .post('/api/escrows/escrow-11/evidence')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .field('description', 'ipfs evidence')
      .attach('file', Buffer.from('proof'), 'evidence.png');

    expect(res.statusCode).toBe(201);
    expect(mockUploadEvidenceToIpfs).toHaveBeenCalledTimes(1);
    expect(mockPrisma.evidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          escrowId: 'escrow-11',
          uploaderId: 'user-1',
          fileUrl: 'https://gateway.pinata.cloud/ipfs/bafy-test-cid?filename=evidence.txt',
          description: 'ipfs evidence'
        })
      })
    );
    expect(res.body.fileUrl).toBe('https://gateway.pinata.cloud/ipfs/bafy-test-cid?filename=evidence.txt');
  });

  it('returns status history for escrow participant', async () => {
    const app = buildApp();
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-10',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3'
    });
    mockPrisma.escrowStatusHistory.findMany.mockResolvedValue([
      {
        id: 'history-1',
        escrowId: 'escrow-10',
        source: 'API',
        fromStatus: 'LOCKED',
        toStatus: 'DISPUTED'
      }
    ]);

    const res = await request(app)
      .get('/api/escrows/escrow-10/status-history?limit=20')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }));

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.escrowStatusHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { escrowId: 'escrow-10' },
        take: 20
      })
    );
    expect(res.body).toHaveLength(1);
  });

});

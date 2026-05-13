import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';

const serviceMock = {
  ServiceError: class ServiceError extends Error {
    constructor(message, statusCode) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  getMediatorReputationSnapshot: jest.fn(),
  getHistory: jest.fn(),
  getSlashes: jest.fn(),
  resolveSlashAppeal: jest.fn()
};

jest.unstable_mockModule('../../src/services/mediator-reputation-service.js', () => serviceMock);

const { default: mediatorRouter } = await import('../../src/routes/mediator.js');
const { default: adminMediatorRouter } = await import('../../src/routes/admin-mediator.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mediator', mediatorRouter);
  app.use('/api/admin/mediator', adminMediatorRouter);
  return app;
}

describe('Mediator reputation routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  it('returns reputation snapshot', async () => {
    serviceMock.getMediatorReputationSnapshot.mockResolvedValue({
      address: '0x1111111111111111111111111111111111111111',
      currentScore: 90,
      summary: { pendingAppeals: 1 },
      history: [],
      slashes: []
    });

    const app = buildApp();
    const res = await request(app).get('/api/mediator/0x1111111111111111111111111111111111111111/reputation');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ currentScore: 90 }));
  });

  it('returns paginated slash records', async () => {
    serviceMock.getSlashes.mockResolvedValue({
      items: [{ id: 'slash-1', appealState: 'OPEN' }],
      total: 1,
      limit: 20,
      offset: 0
    });

    const app = buildApp();
    const res = await request(app)
      .get('/api/mediator/0x1111111111111111111111111111111111111111/slash-records?limit=20&offset=0');

    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 1 });
  });

  it('maps service validation errors to HTTP status', async () => {
    serviceMock.getHistory.mockRejectedValue(new serviceMock.ServiceError('Invalid mediator address', 400));

    const app = buildApp();
    const res = await request(app).get('/api/mediator/not-an-address/reputation-history');

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid mediator address/i);
  });

  it('accepts slash appeal for admin', async () => {
    serviceMock.resolveSlashAppeal.mockResolvedValue({
      id: 'slash-1',
      status: 'CANCELLED',
      resolvedAt: '2026-05-13T00:00:00.000Z',
      mediatorAddress: '0x1111111111111111111111111111111111111111'
    });

    const adminToken = jwt.sign(
      { id: 'admin-1', walletAddress: '0x1111111111111111111111111111111111111111', role: 'ADMIN' },
      process.env.JWT_SECRET
    );

    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/mediator/0x1111111111111111111111111111111111111111/appeal/slash-1/accept')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutionNote: 'valid appeal' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'slash-1', status: 'CANCELLED' }));
    expect(serviceMock.resolveSlashAppeal).toHaveBeenCalled();
  });

  it('rejects slash appeal for admin', async () => {
    serviceMock.resolveSlashAppeal.mockResolvedValue({
      id: 'slash-2',
      status: 'FINALIZED',
      resolvedAt: '2026-05-13T01:00:00.000Z',
      mediatorAddress: '0x1111111111111111111111111111111111111111'
    });

    const adminToken = jwt.sign(
      { id: 'admin-1', walletAddress: '0x1111111111111111111111111111111111111111', role: 'ADMIN' },
      process.env.JWT_SECRET
    );

    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/mediator/0x1111111111111111111111111111111111111111/appeal/slash-2/reject')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolutionNote: 'insufficient evidence' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: 'slash-2', status: 'FINALIZED' }));
  });

  it('blocks admin appeal endpoint without token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/mediator/0x1111111111111111111111111111111111111111/appeal/slash-1/accept')
      .send({});

    expect(res.statusCode).toBe(401);
    expect(serviceMock.resolveSlashAppeal).not.toHaveBeenCalled();
  });
});

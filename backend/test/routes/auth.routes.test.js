import request from 'supertest';
import express from 'express';
import { ethers } from 'ethers';
import { jest } from '@jest/globals';

const mockPrisma = {
  authNonce: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn()
  },
  user: {
    findUnique: jest.fn(),
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: mockPrisma
}));

const { default: authRouter } = await import('../../src/routes/auth.js');

function buildSiweMessage(nonce) {
  return `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('Auth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.authNonce.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('rejects nonce request with invalid address', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/auth/nonce?address=not-an-address');

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/valid ethereum address required/i);
    expect(mockPrisma.authNonce.upsert).not.toHaveBeenCalled();
  });

  it('issues a nonce then verifies signature and returns token', async () => {
    const app = buildApp();
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address.toLowerCase();

    mockPrisma.authNonce.upsert.mockResolvedValue(undefined);
    mockPrisma.authNonce.findUnique.mockResolvedValue({
      address,
      nonce: 'nonce-for-test',
      expiresAt: new Date(Date.now() + 60_000)
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: 'user-1',
      walletAddress: address,
      name: null,
      role: 'USER'
    });

    const nonceRes = await request(app).get(`/api/auth/nonce?address=${wallet.address}`);
    expect(nonceRes.statusCode).toBe(200);
    expect(nonceRes.body).toHaveProperty('nonce');

    const signature = await wallet.signMessage(buildSiweMessage('nonce-for-test'));
    const verifyRes = await request(app)
      .post('/api/auth/verify')
      .send({ address: wallet.address, signature });

    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toHaveProperty('token');
    expect(verifyRes.body.user.walletAddress).toBe(address);
    expect(mockPrisma.authNonce.deleteMany).toHaveBeenCalledWith({
      where: {
        address,
        nonce: 'nonce-for-test'
      }
    });
  });

  it('rejects replay verification when nonce was already consumed', async () => {
    const app = buildApp();
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address.toLowerCase();

    mockPrisma.authNonce.findUnique.mockResolvedValue({
      address,
      nonce: 'nonce-replay',
      expiresAt: new Date(Date.now() + 60_000)
    });
    mockPrisma.authNonce.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      walletAddress: address,
      name: null,
      role: 'USER'
    });

    const signature = await wallet.signMessage(buildSiweMessage('nonce-replay'));

    const firstVerify = await request(app)
      .post('/api/auth/verify')
      .send({ address: wallet.address, signature });
    expect(firstVerify.statusCode).toBe(200);

    const secondVerify = await request(app)
      .post('/api/auth/verify')
      .send({ address: wallet.address, signature });
    expect(secondVerify.statusCode).toBe(400);
    expect(secondVerify.body.error).toMatch(/nonce already consumed/i);
  });

  it('rejects verify when nonce is expired', async () => {
    const app = buildApp();
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address.toLowerCase();

    mockPrisma.authNonce.findUnique.mockResolvedValue({
      address,
      nonce: 'expired-nonce',
      expiresAt: new Date(Date.now() - 1_000)
    });
    mockPrisma.authNonce.delete.mockResolvedValue(undefined);

    const signature = await wallet.signMessage(buildSiweMessage('expired-nonce'));
    const verifyRes = await request(app)
      .post('/api/auth/verify')
      .send({ address: wallet.address, signature });

    expect(verifyRes.statusCode).toBe(400);
    expect(verifyRes.body.error).toMatch(/nonce expired/i);
    expect(mockPrisma.authNonce.delete).toHaveBeenCalledWith({ where: { address } });
  });
});

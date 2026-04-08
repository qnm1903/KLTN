import request from 'supertest';
import express from 'express';
import { jest } from '@jest/globals';
import { PinataSDK } from 'pinata';
import { clearSessions } from '../../src/store/session.js';
import { signToken } from '../../src/middleware/auth.js';

const runPinataIntegration = Boolean(process.env.PINATA_JWT);
const describePinata = runPinataIntegration ? describe : describe.skip;
const DEFAULT_GATEWAY_HOST = 'gateway.pinata.cloud'; // Default pinata host, used for testing

function createPinataClient() {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;

  return new PinataSDK({
    pinataJwt: jwt,
    pinataGateway: process.env.PINATA_GATEWAY_HOST || DEFAULT_GATEWAY_HOST
  });
}

function extractCidFromFileUrl(fileUrl) {
  const match = String(fileUrl || '').match(/\/ipfs\/([^/?#]+)/i);
  return match?.[1] || null;
}

async function cleanupUploadedCid(cid) {
  if (!cid) return;

  const pinata = createPinataClient();
  if (!pinata) return;

  try {
    const listPayload = await pinata.files.public.list().cid(cid).limit(10);
    const fileIds = (listPayload?.files || [])
      .map((file) => file?.id)
      .filter(Boolean);

    if (fileIds.length === 0) {
      return;
    }

    await pinata.files.public.delete(fileIds);
  } catch (error) {
    // Cleanup is best-effort so upload assertions stay deterministic.
    console.warn('Pinata cleanup warning:', error?.message || error);
  }
}

jest.setTimeout(60000);

const mockPrisma = {
  escrow: {
    findUnique: jest.fn()
  },
  evidence: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: mockPrisma
}));

const { default: evidenceRouter } = await import('../../src/routes/evidence.js');

function authHeader(user) {
  return `Bearer ${signToken(user)}`;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/escrows', evidenceRouter);
  return app;
}

describePinata('Pinata evidence integration', () => {
  let uploadedCid = null;

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearSessions();
    uploadedCid = null;

    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-integration-1',
      status: 'DISPUTED',
      disputePhase: 'EVIDENCE_WINDOW',
      buyerId: 'user-1',
      sellerId: 'user-2',
      mediatorId: 'user-3',
      chainEscrowId: '0xabc123'
    });

    mockPrisma.evidence.create.mockImplementation(async ({ data }) => ({
      id: 'evidence-integration-1',
      ...data,
      createdAt: new Date('2026-04-08T00:00:00.000Z'),
      uploader: {
        id: 'user-1',
        walletAddress: '0x1',
        name: 'Buyer'
      }
    }));
  });

  afterEach(async () => {
    await cleanupUploadedCid(uploadedCid);
    await clearSessions();
  });

  it('uploads evidence to Pinata and persists the gateway URL', async () => {
    if (!process.env.PINATA_JWT) {
      throw new Error('PINATA_JWT is required to run the Pinata integration test');
    }

    const gatewayHost = process.env.PINATA_GATEWAY_HOST || DEFAULT_GATEWAY_HOST;
    const app = buildApp();

    const res = await request(app)
      .post('/api/escrows/escrow-integration-1/evidence')
      .set('Authorization', authHeader({ id: 'user-1', walletAddress: '0x1', role: 'USER' }))
      .field('description', 'integration evidence')
      .attach('file', Buffer.from('integration-test'), {
        filename: 'integration-evidence.png',
        contentType: 'image/png'
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.description).toBe('integration evidence');
    expect(res.body.fileUrl).toContain(`https://${gatewayHost}/ipfs/`);
    expect(res.body.fileUrl).not.toContain('/uploads/');
    uploadedCid = extractCidFromFileUrl(res.body.fileUrl);
    expect(uploadedCid).toBeTruthy();
    expect(mockPrisma.evidence.create).toHaveBeenCalledTimes(1);

    const createArgs = mockPrisma.evidence.create.mock.calls[0][0];
    expect(createArgs.data.fileUrl).toContain(`https://${gatewayHost}/ipfs/`);
    expect(createArgs.data.fileUrl).not.toContain('/uploads/');
  });
});
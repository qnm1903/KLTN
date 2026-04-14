import request from 'supertest';
import { jest } from '@jest/globals';
import { clearSessions } from '../../src/store/session.js';

const mockPrisma = {
  escrow: {
    findUnique: jest.fn()
  },
  pubKeySubmission: {
    deleteMany: jest.fn()
  }
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: mockPrisma
}));

const { default: app } = await import('../../src/app.js');

describe('Escrow Incremental Init Route', () => {
  const contractAddress = '0x00000000000000000000000000000000000000aa';
  const chainId = '31337';

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearSessions();

    mockPrisma.pubKeySubmission.deleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(async () => {
    await clearSessions();
  });

  it('initializes incremental pubkey collection session and returns pending collection state', async () => {
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-db-1',
      buyer: { walletAddress: '0x1111111111111111111111111111111111111111' },
      seller: { walletAddress: '0x2222222222222222222222222222222222222222' },
      escrowMediators: [
        { slot: 1, mediator: { walletAddress: '0x3333333333333333333333333333333333333331' } },
        { slot: 2, mediator: { walletAddress: '0x3333333333333333333333333333333333333332' } },
        { slot: 3, mediator: { walletAddress: '0x3333333333333333333333333333333333333333' } },
        { slot: 4, mediator: { walletAddress: '0x3333333333333333333333333333333333333334' } },
        { slot: 5, mediator: { walletAddress: '0x3333333333333333333333333333333333333335' } }
      ]
    });

    const response = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId: 'escrow-db-1',
        chainId,
        contractAddress
      });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.collection.state).toBe('PENDING');
    expect(response.body.collection.received).toBe(0);
    expect(response.body.collection.required).toBe(7);
  });

  it('returns 409 when escrow participants are incomplete for incremental init', async () => {
    mockPrisma.escrow.findUnique.mockResolvedValue({
      id: 'escrow-db-2',
      buyer: { walletAddress: '0x1111111111111111111111111111111111111111' },
      seller: { walletAddress: '0x2222222222222222222222222222222222222222' },
      escrowMediators: [
        { slot: 1, mediator: { walletAddress: '0x3333333333333333333333333333333333333331' } },
        { slot: 2, mediator: { walletAddress: '0x3333333333333333333333333333333333333332' } }
      ]
    });

    const response = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId: 'escrow-db-2',
        chainId,
        contractAddress
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatch(/participants are incomplete/i);
  });
});

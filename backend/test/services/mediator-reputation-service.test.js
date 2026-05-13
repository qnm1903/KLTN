import { jest } from '@jest/globals';

const mockPrisma = {
  mediatorSlash: {
    findUnique: jest.fn(),
    update: jest.fn()
  }
};

jest.unstable_mockModule('../../src/lib/prisma.js', () => ({
  default: mockPrisma
}));

const {
  resolveSlashAppeal,
  ServiceError
} = await import('../../src/services/mediator-reputation-service.js');

describe('mediator-reputation-service resolveSlashAppeal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects resolving when appeal window is expired', async () => {
    mockPrisma.mediatorSlash.findUnique.mockResolvedValue({
      id: 'slash-1',
      mediatorAddress: '0x1111111111111111111111111111111111111111',
      status: 'PENDING',
      appealDeadlineAt: new Date(Date.now() - 1_000)
    });

    await expect(resolveSlashAppeal({
      address: '0x1111111111111111111111111111111111111111',
      slashId: 'slash-1',
      action: 'accept',
      resolvedBy: 'admin-1'
    })).rejects.toMatchObject({
      message: 'Appeal window expired',
      statusCode: 409
    });
  });

  it('updates slash status for valid pending slash in open window', async () => {
    const now = new Date();
    mockPrisma.mediatorSlash.findUnique.mockResolvedValue({
      id: 'slash-2',
      mediatorAddress: '0x1111111111111111111111111111111111111111',
      status: 'PENDING',
      appealDeadlineAt: new Date(now.getTime() + 86_400_000)
    });
    mockPrisma.mediatorSlash.update.mockResolvedValue({ id: 'slash-2', status: 'FINALIZED' });

    const result = await resolveSlashAppeal({
      address: '0x1111111111111111111111111111111111111111',
      slashId: 'slash-2',
      action: 'reject',
      resolvedBy: 'admin-1'
    });

    expect(result).toEqual({ id: 'slash-2', status: 'FINALIZED' });
    expect(mockPrisma.mediatorSlash.update).toHaveBeenCalled();
  });

  it('throws ServiceError for invalid address', async () => {
    await expect(resolveSlashAppeal({
      address: 'invalid',
      slashId: 'slash-3',
      action: 'accept'
    })).rejects.toBeInstanceOf(ServiceError);
  });
});

import React from 'react';
import { Provider, useAtomValue } from 'jotai';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionRecovery } from '../../../src/features/escrow/useSessionRecovery';
import { escrowStatusAtom, signatureProgressAtom } from '../../../src/features/escrow/escrowStore';

const getSessionMock = vi.fn();
const saveSessionMock = vi.fn();

vi.mock('../../../src/lib/storage', () => ({
  getSession: (...args) => getSessionMock(...args),
  saveSession: (...args) => saveSessionMock(...args)
}));

function HookHarness({ escrowId, walletAddress }) {
  const { isRecovering } = useSessionRecovery(escrowId, walletAddress);
  const status = useAtomValue(escrowStatusAtom);
  const progress = useAtomValue(signatureProgressAtom);

  return (
    <div>
      <span data-testid="recovering">{String(isRecovering)}</span>
      <span data-testid="status">{status}</span>
      <span data-testid="progress">{progress}</span>
    </div>
  );
}

describe('useSessionRecovery smoke', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    saveSessionMock.mockReset();
  });

  it('skips storage access when wallet is not available', async () => {
    render(
      <Provider>
        <HookHarness escrowId="escrow-1" walletAddress={null} />
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('recovering')).toHaveTextContent('false');
    });

    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('rehydrates snapshot and schedules autosave when wallet exists', async () => {
    getSessionMock.mockResolvedValue({
      status: 'computing_keys',
      progress: 3,
      signedNodes: ['buyer'],
      timestamp: Date.now() - 1000
    });

    render(
      <Provider>
        <HookHarness escrowId="escrow-2" walletAddress="0xabc" />
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('computing_keys');
      expect(screen.getByTestId('progress')).toHaveTextContent('3');
    });

    expect(getSessionMock).toHaveBeenCalledWith('escrow-2', '0xabc');
    expect(saveSessionMock).toHaveBeenCalled();
  });
});

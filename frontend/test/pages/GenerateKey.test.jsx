import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenerateKey from '../../src/pages/GenerateKey';

const savePubKeyMock = vi.fn();
const signMessageMock = vi.fn();

vi.mock('viem', () => ({
  hashMessage: () => '0xhash',
  recoverPublicKey: () => Promise.resolve(`0x04${'22'.repeat(64)}`)
}));

vi.mock('wagmi', () => ({
  useConnection: () => ({ address: '0x1234567890123456789012345678901234567890' }),
  useSignMessage: () => ({ mutateAsync: (...args) => signMessageMock(...args) })
}));

vi.mock('../../src/lib/storage', () => ({
  savePubKey: (...args) => savePubKeyMock(...args)
}));

describe('GenerateKey smoke', () => {
  beforeEach(() => {
    savePubKeyMock.mockClear();
    signMessageMock.mockReset();
    signMessageMock.mockResolvedValue('0xsigned-message');
  });

  it('renders and derives public key from signed message', async () => {
    const user = userEvent.setup();
    render(<GenerateKey />);

    await user.click(screen.getByRole('button', { name: /generate my tss keys/i }));

    expect(savePubKeyMock).toHaveBeenCalledWith(
      `0x04${'22'.repeat(64)}`,
      '0x1234567890123456789012345678901234567890'
    );

    expect(screen.getByDisplayValue(`0x04${'22'.repeat(64)}`)).toBeInTheDocument();
  });
});

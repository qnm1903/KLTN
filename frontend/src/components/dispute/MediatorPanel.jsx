import React, { useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { useAtomValue, useSetAtom } from 'jotai';
import { mediatorsListAtom, voteTallyAtom, currentDisputeAtom } from '../../store/disputeAtoms.js';
import { MEDIATOR_STATUS } from '../../constants/dispute.constants.js';
import { acceptMediator } from '../../services/dispute.service.js';

/**
 * MediatorPanel
 * - Hiển thị danh sách 7 mediators với giao diện Dark Cyber / Glassmorphism.
 * - KHÔNG thay đổi logic Web3 (useWalletClient / signTypedData) hay Jotai state logic.
 * - Chỉ thay đổi UI: màu sắc, background, button style, badges, progress bar.
 *
 */

const MediatorPanel = () => {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const setMediators = useSetAtom(mediatorsListAtom);
  const currentDispute = useAtomValue(currentDisputeAtom);
  const [processingMediator, setProcessingMediator] = React.useState(null);
  const mediators = useAtomValue(mediatorsListAtom) || [];
  const tally = useAtomValue(voteTallyAtom) || {
    RELEASE_TO_BUYER: 0,
    RETURN_TO_SELLER: 0,
    SPLIT: 0,
    OTHER: 0,
    totalVotes: 0,
    threshold: 5
  };

const handleMediatorDecision = async (mediatorAddr, action) => {
  if (!mediatorAddr || !walletClient || !address || !currentDispute) return;
  setProcessingMediator(mediatorAddr);

  try {
    // Normalize decision as backend expects 'accept' or 'decline'
    const decision = String(action || '').toLowerCase() === 'accept' ? 'accept' : 'decline';

    // Build EIP-712 message matching backend's ACCEPT_MEDIATOR_TYPE
    const nonce = 0; // first-time mediator nonce; backend will verify/consume
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes into the future

    const message = {
      disputeId: currentDispute?.disputeId || currentDispute?.id || '',
      escrowId: currentDispute?.escrowId || '',
      mediator: mediatorAddr,
      decision,
      nonce,
      deadline
    };

    // Domain + Types must match backend/src/types/dispute-typed-data.js: ACCEPT_MEDIATOR_TYPE
    const domain = {
      name: 'KLTNDisputeVoting',
      version: '1',
      chainId: 11155111,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const types = {
      AcceptMediator: [
        { name: 'disputeId', type: 'string' },
        { name: 'escrowId', type: 'string' },
        { name: 'mediator', type: 'address' },
        { name: 'decision', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
      ]
    };

    // Sign typed data with wallet client (MetaMask)
    const signature = await walletClient.signTypedData({
      domain,
      types,
      primaryType: 'AcceptMediator',
      message,
      account: address
    });

    // Call backend with exactly the fields it expects
    await acceptMediator(message.disputeId, {
      decision,
      signature,
      message
    });

    // Update local mediators list UI optimistically
    setMediators((prev) => prev.map((m) =>
      (m.address || (m.mediator && m.mediator.walletAddress) || m.mediatorId || '').toLowerCase() === mediatorAddr.toLowerCase()
        ? { ...m, status: decision === 'accept' ? 'ACCEPTED' : 'DECLINED', acceptedAt: decision === 'accept' ? new Date().toISOString() : null, declinedAt: decision === 'decline' ? new Date().toISOString() : null }
        : m
    ));
  } catch (err) {
    console.error('Decision error', err);
  } finally {
    setProcessingMediator(null);
  }
};

  // Prefer a real committee size (5) and use dispute data when available.
const COMMITTEE_SIZE = 5;
const sourceMediators = (currentDispute?.mediators && currentDispute.mediators.length > 0)
  ? currentDispute.mediators
  : mediators || [];

const padded = Array.from({ length: COMMITTEE_SIZE }).map((_, i) => {
  const m = sourceMediators[i] || null;
  if (!m) {
    return {
      address: `unassigned-${i + 1}`,
      status: MEDIATOR_STATUS.ASSIGNED,
      acceptedAt: null,
      declinedAt: null,
      votedAt: null,
      voteChoice: null,
      score: null,
      note: null
    };
  }

  // Support multiple shapes returned by backend: { address } or { mediator: { walletAddress } }
  const address = m.address || (m.mediator && m.mediator.walletAddress) || m.mediatorId || '';
  return {
    address,
    status: m.status || MEDIATOR_STATUS.ASSIGNED,
    acceptedAt: m.acceptedAt || null,
    declinedAt: m.declinedAt || null,
    votedAt: m.votedAt || null,
    voteChoice: m.voteChoice || null,
    score: m.score || null,
    note: m.note || null
  };
});

  return (
    <div className="bg-slate-800/50 backdrop-blur-md border border-slate-700/50 rounded-xl shadow-xl shadow-black/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-200">Assigned Mediators ({COMMITTEE_SIZE})</h4>
        <div className="text-xs text-slate-400">Threshold: {tally.threshold || 5}</div>
      </div>

      {/* Mediator list */}
      <ul className="space-y-3">
        {padded.map((m, i) => (
          <li key={`${m.address}-${i}`} className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-slate-700 rounded-md flex items-center justify-center text-sm font-medium text-slate-300">
                {m.address && m.address.startsWith('0x') ? m.address.slice(2, 4).toUpperCase() : `M${i + 1}`}
              </div>
              <div className="flex flex-col">
                <div className="text-sm text-slate-200">{truncateAddr(m.address)}</div>
                <div className="text-xs text-slate-400">{m.score ? `Score ${m.score}` : 'No score'}</div>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              {address && m.address && address.toLowerCase() === m.address.toLowerCase() && m.status === MEDIATOR_STATUS.ASSIGNED ? (
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleMediatorDecision(m.address, 'ACCEPT')}
                    disabled={processingMediator === m.address}
                    className="px-3 py-1 rounded-md bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 text-sm hover:bg-emerald-500/40 disabled:opacity-50"
                  >
                    {processingMediator === m.address ? '...' : 'Accept'}
                  </button>
                  <button
                    onClick={() => handleMediatorDecision(m.address, 'DECLINE')}
                    disabled={processingMediator === m.address}
                    className="px-3 py-1 rounded-md bg-rose-500/20 text-rose-400 border border-rose-500/50 text-sm hover:bg-rose-500/40 disabled:opacity-50"
                  >
                    {processingMediator === m.address ? '...' : 'Decline'}
                  </button>
                </div>
              ) : (
                <>
                  <StatusBadge status={m.status} />
                  <div className="text-xs text-slate-400">{m.votedAt ? new Date(m.votedAt).toLocaleString() : ''}</div>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Voting progress bar */}
      <div className="mt-4">
        <VotingProgressBar tally={tally} total={COMMITTEE_SIZE} />
      </div>
    </div>
  );
};

/* StatusBadge component - dark theme */
const StatusBadge = ({ status }) => {
  const map = {
    [MEDIATOR_STATUS.ASSIGNED]: { label: 'Assigned', cls: 'bg-slate-700/40 text-slate-200' },
    [MEDIATOR_STATUS.ACCEPTED]: { label: 'Accepted', cls: 'bg-emerald-700/30 text-emerald-300' },
    [MEDIATOR_STATUS.VOTED]: { label: 'Voted', cls: 'bg-amber-600/30 text-amber-300' },
    [MEDIATOR_STATUS.DECLINED]: { label: 'Declined', cls: 'bg-rose-700/30 text-rose-300' },
    [MEDIATOR_STATUS.NO_RESPONSE]: { label: 'No response', cls: 'bg-yellow-700/30 text-yellow-300' }
  };
  const item = map[status] || map[MEDIATOR_STATUS.ASSIGNED];
  return <span className={`px-3 py-1 rounded-full text-xs font-medium ${item.cls} border border-white/5`}>{item.label}</span>;
};

/* VotingProgressBar inline */
const VotingProgressBar = ({ tally, total = 5 }) => {
  const TOTAL = total;
  const order = ['RELEASE_TO_BUYER', 'RETURN_TO_SELLER', 'SPLIT', 'OTHER'];
  const filled = [];

  order.forEach((k) => {
    const count = tally[k] || 0;
    for (let i = 0; i < count; i++) {
      if (filled.length < TOTAL) filled.push(k);
    }
  });

  const slots = Array.from({ length: TOTAL }).map((_, i) => {
    const outcome = filled[i] || null;
    const color =
      outcome === 'RELEASE_TO_BUYER'
        ? 'bg-emerald-500'
        : outcome === 'RETURN_TO_SELLER'
        ? 'bg-rose-500'
        : outcome === 'SPLIT'
        ? 'bg-amber-500'
        : 'bg-slate-600';
    const filledFlag = !!outcome;
    return { color, filled: filledFlag };
  });

  const threshold = tally.threshold || 5;
  const thresholdPosPercent = ((threshold - 1) / (TOTAL - 1)) * 100; // threshold tick position

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-slate-200">Voting progress</div>
        <div className="text-sm text-slate-200">{tally.totalVotes}/{TOTAL} votes</div>
      </div>

      <div className="relative w-full h-12 flex items-center">
        <div className="absolute left-4 right-4 h-2 bg-slate-700/40 rounded-full" />
        <div
          className="absolute top-1.5 h-8 w-0.5 bg-indigo-400"
          style={{ left: `${thresholdPosPercent}%`, transform: 'translateX(-50%)' }}
          title={`Threshold (${threshold} votes required)`}
        />

        <div className="relative z-10 flex items-center justify-between w-full px-4">
          {slots.map((s, idx) => (
            <div key={idx} className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${s.color} ${s.filled ? 'shadow-[0_6px_18px_rgba(0,0,0,0.5)]' : 'opacity-70'}`}>
                {s.filled ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 10-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <div className="w-2 h-2 rounded-full bg-white/30" />
                )}
              </div>
              <div className="mt-2 text-xs text-slate-400">#{idx + 1}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center space-x-4">
        <Legend color="bg-emerald-500" label="Release to Buyer" />
        <Legend color="bg-rose-500" label="Return to Seller" />
        <Legend color="bg-amber-500" label="Split" />
        <Legend color="bg-slate-600" label="Other" />
        <div className="ml-auto text-sm text-slate-400">Threshold: {threshold} votes</div>
      </div>
    </div>
  );
};

const Legend = ({ color, label }) => (
  <div className="flex items-center space-x-2">
    <div className={`w-3 h-3 rounded ${color}`} />
    <div className="text-xs text-slate-400">{label}</div>
  </div>
);

function truncateAddr(addr = '', front = 6, back = 4) {
  if (!addr) return '';
  if (addr.length <= front + back) return addr;
  return `${addr.slice(0, front)}...${addr.slice(-back)}`;
}

export default MediatorPanel;
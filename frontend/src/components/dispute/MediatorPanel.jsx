// frontend/src/components/dispute/MediatorPanel.jsx
// Component hiển thị danh sách Mediators (7) và Voting progress bar.
// Comment bằng tiếng Việt; giữ nguyên các thuật ngữ IT/Web3 (Mediator, VoteTally, Jotai atom).

import React from 'react';
import { useAtomValue } from 'jotai';
import { mediatorsListAtom, voteTallyAtom } from '../../store/disputeAtoms.js';
import { MEDIATOR_STATUS } from '../../constants/dispute.constants.js';

/**
 * MediatorPanel
 * - Đọc mediatorsListAtom và voteTallyAtom.
 * - Render list 7 mediators với status badge.
 * - Bao gồm VotingProgressBar inline (7 ticks, threshold marker tại 5).
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
    if (!mediatorAddr || !walletClient || !address) return;
    setProcessingMediator(mediatorAddr);

    try {
      const message = {
        mediator: mediatorAddr,
        disputeId: currentDispute?.disputeId || '',
        action: action,
        timestamp: new Date().toISOString()
      };

      const domain = { name: 'DisputeEscrow', version: '1' };
      const types = { AcceptMediator: [{ name: 'mediator', type: 'address' }, { name: 'disputeId', type: 'string' }, { name: 'action', type: 'string' }, { name: 'timestamp', type: 'string' }] };

      const signature = await walletClient.signTypedData({
        domain, types, primaryType: 'AcceptMediator', message, account: address
      });

      await acceptMediator(message.disputeId, { mediator: mediatorAddr, signature, timestamp: message.timestamp });
      
      setMediators((prev) => prev.map((m) =>
        m.address.toLowerCase() === mediatorAddr.toLowerCase()
          ? { ...m, status: action === 'ACCEPT' ? MEDIATOR_STATUS.ACCEPTED : MEDIATOR_STATUS.DECLINED } : m
      ));
    } catch (err) {
      console.error('Decision error', err);
    } finally {
      setProcessingMediator(null);
    }
  };

  // Ensure 7 slots for UI
  const padded = Array.from({ length: 7 }).map((_, i) => mediators[i] || null).map((m, idx) =>
    m
      ? m
      : {
          address: `unassigned-${idx + 1}`,
          status: MEDIATOR_STATUS.ASSIGNED,
          acceptedAt: null,
          declinedAt: null,
          votedAt: null,
          voteChoice: null,
          score: null,
          note: null
        }
  );

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700">Assigned Mediators (7)</h4>
        <div className="text-xs text-gray-500">Threshold: {tally.threshold || 5}</div>
      </div>

      {/* Mediator list */}
      <ul className="space-y-3">
        {padded.map((m, i) => (
          <li key={`${m.address}-${i}`} className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gray-50 rounded-md flex items-center justify-center text-sm font-medium text-gray-700">
                {m.address && m.address.startsWith('0x') ? m.address.slice(2, 4).toUpperCase() : `M${i + 1}`}
              </div>
              <div className="flex flex-col">
                <div className="text-sm text-gray-800">{truncateAddr(m.address)}</div>
                <div className="text-xs text-gray-500">{m.score ? `Score ${m.score}` : 'No score'}</div>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              {address && m.address && address.toLowerCase() === m.address.toLowerCase() && m.status === MEDIATOR_STATUS.ASSIGNED ? (
                <div className="flex items-center space-x-2">
                  <button onClick={() => handleMediatorDecision(m.address, 'ACCEPT')} disabled={processingMediator === m.address} className="px-3 py-1 rounded-md bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50">
                    {processingMediator === m.address ? '...' : 'Accept'}
                  </button>
                  <button onClick={() => handleMediatorDecision(m.address, 'DECLINE')} disabled={processingMediator === m.address} className="px-3 py-1 rounded-md bg-red-100 text-red-800 text-sm hover:bg-red-200 disabled:opacity-50">
                    {processingMediator === m.address ? '...' : 'Decline'}
                  </button>
                </div>
              ) : (
                <>
                  <StatusBadge status={m.status} />
                  <div className="text-xs text-gray-400">{m.votedAt ? new Date(m.votedAt).toLocaleString() : ''}</div>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Voting progress bar */}
      <div className="mt-4">
        <VotingProgressBar tally={tally} />
      </div>
    </div>
  );
};

/* StatusBadge component */
const StatusBadge = ({ status }) => {
  const map = {
    [MEDIATOR_STATUS.ASSIGNED]: { label: 'Assigned', cls: 'bg-gray-100 text-gray-800' },
    [MEDIATOR_STATUS.ACCEPTED]: { label: 'Accepted', cls: 'bg-blue-100 text-blue-800' },
    [MEDIATOR_STATUS.VOTED]: { label: 'Voted', cls: 'bg-green-100 text-green-800' },
    [MEDIATOR_STATUS.DECLINED]: { label: 'Declined', cls: 'bg-red-100 text-red-800' },
    [MEDIATOR_STATUS.NO_RESPONSE]: { label: 'No response', cls: 'bg-yellow-100 text-yellow-800' }
  };
  const item = map[status] || map[MEDIATOR_STATUS.ASSIGNED];
  return <span className={`px-3 py-1 rounded-full text-xs font-medium ${item.cls}`}>{item.label}</span>;
};

/* VotingProgressBar inline */
/* - Displays 7 ticks, fills according to tally counts in order: RELEASE_TO_BUYER, RETURN_TO_SELLER, SPLIT, OTHER */
const VotingProgressBar = ({ tally }) => {
  const TOTAL = 7;
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
    const color = outcome === 'RELEASE_TO_BUYER' ? 'bg-green-500' : outcome === 'RETURN_TO_SELLER' ? 'bg-red-500' : outcome === 'SPLIT' ? 'bg-amber-500' : 'bg-gray-300';
    const filledFlag = !!outcome;
    return { color, filled: filledFlag };
  });

  const thresholdPosPercent = ((5 - 1) / (TOTAL - 1)) * 100; // 5th tick position

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-gray-600">Voting progress</div>
        <div className="text-sm text-gray-600">{tally.totalVotes}/{TOTAL} votes</div>
      </div>

      <div className="relative w-full h-12 flex items-center">
        <div className="absolute left-4 right-4 h-2 bg-gray-100 rounded-full" />
        <div
          className="absolute top-1.5 h-8 w-0.5 bg-indigo-400"
          style={{ left: `${thresholdPosPercent}%`, transform: 'translateX(-50%)' }}
          title="Threshold (5 votes required)"
        />

        <div className="relative z-10 flex items-center justify-between w-full px-4">
          {slots.map((s, idx) => (
            <div key={idx} className="flex flex-col items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${s.color} ${s.filled ? 'shadow-md' : 'opacity-80'}`}>
                {s.filled ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 10-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <div className="w-2 h-2 rounded-full bg-white/60" />
                )}
              </div>
              <div className="mt-2 text-xs text-gray-500">#{idx + 1}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center space-x-4">
        <Legend color="bg-green-500" label="Release to Buyer" />
        <Legend color="bg-red-500" label="Return to Seller" />
        <Legend color="bg-amber-500" label="Split" />
        <Legend color="bg-gray-300" label="Other" />
        <div className="ml-auto text-sm text-gray-500">Threshold: 5 votes</div>
      </div>
    </div>
  );
};

const Legend = ({ color, label }) => (
  <div className="flex items-center space-x-2">
    <div className={`w-3 h-3 rounded ${color}`} />
    <div className="text-xs text-gray-600">{label}</div>
  </div>
);

function truncateAddr(addr = '', front = 6, back = 4) {
  if (!addr) return '';
  if (addr.length <= front + back) return addr;
  return `${addr.slice(0, front)}...${addr.slice(-back)}`;
}

export default MediatorPanel;
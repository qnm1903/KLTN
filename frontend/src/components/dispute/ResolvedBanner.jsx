import React from 'react';
import { useAtomValue } from 'jotai';
import { currentDisputeAtom } from '../../store/disputeAtoms.js';
import { VOTE_CHOICE } from '../../constants/dispute.constants.js';

/**
 * ResolvedBanner
 *
 * - Hiển thị outcome badge (màu tuỳ theo outcome).
 * - Text "Dispute finalized on-chain" + link tới on-chain tx nếu có.
 * - Hiển thị compact list các mediator addresses (5) who formed quorum (nếu provided in dispute.onChain or resolvingMediators).
 *
 * Props:
 * - dispute (optional) : nếu provided sẽ dùng; nếu không, component tự read từ currentDisputeAtom.
 */
export default function ResolvedBanner({ dispute: propDispute = null }) {
  const atomDispute = useAtomValue(currentDisputeAtom);
  const dispute = propDispute || atomDispute;

  if (!dispute || dispute.status !== 'RESOLVED') return null;

  const outcome = dispute.outcome || 'UNKNOWN';

  const outcomeMeta = (() => {
    switch (outcome) {
      case VOTE_CHOICE.RELEASE_TO_BUYER:
        return { label: 'Release to Buyer', cls: 'bg-green-50 text-green-800' };
      case VOTE_CHOICE.RETURN_TO_SELLER:
        return { label: 'Return to Seller', cls: 'bg-red-50 text-red-800' };
      case VOTE_CHOICE.SPLIT:
        return { label: 'Split', cls: 'bg-amber-50 text-amber-800' };
      default:
        return { label: outcome, cls: 'bg-gray-100 text-gray-800' };
    }
  })();

  // Collect resolving mediators: try to find in dispute.onChain.events or dispute.resolvingMediators
  // For mock data we may have dispute.onChain.resolvingMediators or dispute.resolvingMediators
  const resolving = dispute.resolvingMediators || (dispute.onChain && dispute.onChain.resolvingMediators) || [];

  // If not provided, fall back to first 5 mediators from dispute.mediators
  const quorumMediators = resolving.length > 0 ? resolving : (dispute.mediators ? dispute.mediators.slice(0, 5).map((m) => m.address) : []);

  const txHash = dispute.onChainTxHash || (dispute.onChain && dispute.onChain.events && dispute.onChain.events.slice(-1)[0] && dispute.onChain.events.slice(-1)[0].txHash) || null;
  const etherscanUrl = txHash ? `https://etherscan.io/tx/${txHash}` : '#';

  return (
    <div className="bg-white rounded-md shadow-sm p-4 mb-6 border-l-4 border-indigo-600">
      <div className="flex items-start justify-between space-x-4">
        <div className="flex items-center space-x-4">
          <div className={`px-3 py-1 rounded-full text-sm font-medium ${outcomeMeta.cls}`}>{outcomeMeta.label}</div>
          <div>
            <div className="text-sm font-semibold text-gray-800">Dispute finalized on-chain</div>
            <div className="text-xs text-gray-500 mt-1">
              Finalized at: {dispute.finalizedAt ? new Date(dispute.finalizedAt).toLocaleString() : 'Unknown'}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <a href={etherscanUrl} target="_blank" rel="noreferrer" className="text-sm px-3 py-1 bg-indigo-50 text-indigo-700 rounded">
            {txHash ? 'View on Etherscan' : 'On-chain tx'}
          </a>
        </div>
      </div>

      {/* Quorum mediators */}
      <div className="mt-4">
        <div className="text-sm text-gray-600 mb-2">Quorum mediators (5)</div>
        <div className="flex flex-wrap gap-2">
          {quorumMediators && quorumMediators.length > 0 ? (
            quorumMediators.map((addr, i) => (
              <div key={`${addr}-${i}`} className="px-2 py-1 rounded bg-gray-50 border text-xs font-mono text-gray-700">
                {truncate(addr)}
              </div>
            ))
          ) : (
            <div className="text-xs text-gray-400">No mediator list available</div>
          )}
        </div>
      </div>
      {/* FIXED: Add CTA to redirect users back to the TSS Execution Workspace */}
      <div className="mt-5 pt-4 border-t border-indigo-100/50 flex justify-end">
        <button
          onClick={() => window.location.href = `/escrows/${dispute.escrowId}`}
          className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg shadow-md transition-all flex items-center hover:scale-105"
        >
          Proceed to TSS Execution Workspace
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* Helpers */
function truncate(addr = '', front = 6, back = 4) {
  if (!addr) return '';
  if (addr.length <= front + back) return addr;
  return `${addr.slice(0, front)}...${addr.slice(-back)}`;
}
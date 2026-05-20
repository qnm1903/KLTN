import React, { useState } from 'react';
import { useAccount } from 'wagmi';
import VRFLoadingState from '../components/dispute/VRFLoadingState.jsx';
import EvidenceTimeline from '../components/dispute/EvidenceTimeline.jsx';
import EvidenceUploadModal from '../components/dispute/EvidenceUploadModal.jsx';
import MediatorPanel from '../components/dispute/MediatorPanel.jsx';
import useDisputeDetail from '../hooks/useDisputeDetail.js';
import { useDisputeWebSocket } from '../hooks/useDisputeWebSocket.js';
import { DISPUTE_STATUS } from '../constants/dispute.constants.js';
import { useParams } from 'react-router-dom';

const DisputeDetail = () => {
  const { address } = useAccount();
  const { id } = useParams();
  const { currentDispute, status } = useDisputeDetail(id);
  useDisputeWebSocket(id);
  const displayStatus = status ?? DISPUTE_STATUS.PENDING_VRF;
  const viewerRole = deriveViewerRole(currentDispute, address);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);

  return (
    <div className="min-h-screen py-8 px-6 bg-linear-to-br from-slate-900 via-slate-800 to-indigo-950">
      <div className="max-w-7xl mx-auto p-6">
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-slate-200">Dispute Detail</h1>
            <div className="text-sm text-slate-400 flex items-center space-x-3">
              <span className="text-slate-400">Status</span>
              <span className="inline-flex items-center px-3 py-1 rounded text-sm bg-indigo-500/20 text-indigo-300 border border-indigo-500/50 shadow-[0_0_18px_rgba(99,102,241,0.12)] backdrop-blur-md">
                {displayStatus}
              </span>
            </div>
          </div>
          <p className="text-sm text-slate-400 mt-2">Thông tin chi tiết dispute, evidence và mediator panel.</p>
        </header>

        <section className="mb-6 p-4 rounded-xl bg-slate-900/40 border border-slate-700/60">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-slate-400">Your role</div>
              <div className="text-base font-semibold text-slate-200">{viewerRole.toUpperCase()}</div>
            </div>
            <ExecutionStatus executionStatus={currentDispute?.executionStatus} executionError={currentDispute?.executionError} txHash={currentDispute?.onChainTxHash} />
          </div>
        </section>

        <main>
          {displayStatus === DISPUTE_STATUS.PENDING_VRF ? (
            <div className="mb-6">
              <div className="p-6 rounded-lg bg-white/3 border border-white/5 backdrop-blur-md">
                <VRFLoadingState requestId={currentDispute?.requestId} txHash={currentDispute?.onChainTxHash} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left / Center: Evidence (span 2 cols on large) */}
              <div className="lg:col-span-2">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-medium text-slate-200">Evidence Timeline</h3>
                    <p className="text-sm text-slate-400">Danh sách Evidence đã upload (off-chain/IPFS).</p>
                  </div>
                  {/* Chỉ Buyer hoặc Seller mới có quyền Upload */}
                  {(viewerRole === 'buyer/seller' || viewerRole === 'buyer' || viewerRole === 'seller') && (
                    <button
                      onClick={() => setIsUploadModalOpen(true)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg shadow-md transition-colors flex items-center"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Upload Evidence
                    </button>
                  )}
                </div>
                <div className="p-4 rounded-xl bg-linear-to-tr from-white/4 to-white/2 border border-white/5 backdrop-blur-md">
                  <EvidenceTimeline />
                </div>
              </div>

              {/* Right: Mediator Panel */}
              <div>
                <div className="p-4 rounded-xl bg-linear-to-tr from-white/4 to-white/2 border border-white/5 backdrop-blur-md">
                  <MediatorPanel />
                </div>
                {viewerRole !== 'mediator' ? (
                  <div className="mt-3 p-4 rounded-xl bg-slate-900/40 border border-slate-700/60">
                    <ParticipantRoleHint role={viewerRole} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {/* Nhúng Modal Upload */}
          <EvidenceUploadModal
            isOpen={isUploadModalOpen}
            onClose={() => setIsUploadModalOpen(false)}
            disputeId={id}
            onUpload={() => {
              setIsUploadModalOpen(false);
              window.location.reload(); 
            }}
          />
        </main>
      </div>
    </div>
  );
};

function deriveViewerRole(dispute, walletAddress) {
  const normalizedWallet = String(walletAddress || '').toLowerCase();
  if (dispute?.viewerRole) return dispute.viewerRole;
  if (!normalizedWallet || !dispute) return 'unknown';

  const mediatorMatched = Array.isArray(dispute.mediators)
    && dispute.mediators.some((m) => String(m.address || '').toLowerCase() === normalizedWallet);
  if (mediatorMatched) return 'mediator';

  if (String(dispute.initiatorAddress || '').toLowerCase() === normalizedWallet) return 'buyer/seller';
  return 'unknown';
}

function ExecutionStatus({ executionStatus, executionError, txHash }) {
  const status = executionStatus || 'NOT_STARTED';
  return (
    <div className="text-right">
      <div className="text-xs text-slate-400">Execution</div>
      <div className="text-sm font-medium text-slate-200">{status}</div>
      {txHash ? <div className="text-xs text-emerald-300">tx: {String(txHash).slice(0, 10)}...{String(txHash).slice(-8)}</div> : null}
      {executionError ? <div className="text-xs text-rose-300">{executionError}</div> : null}
    </div>
  );
}

function ParticipantRoleHint({ role }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-200">Participant Actions</h4>
      <p className="text-sm text-slate-400">
        Role hiện tại: <span className="text-slate-200 font-medium">{role}</span>
      </p>
      <p className="text-sm text-slate-400">
        Trong dispute phase, buyer/seller nên theo dõi vote + upload evidence. Khi dispute finalized,
        chữ ký execution nên được submit qua luồng escrow (nonce/sign endpoints).
      </p>
    </div>
  );
}

export default DisputeDetail;
import React, { useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { submitVote } from '../../services/dispute.service.js';
import signatureUtils from '../../utils/signatureUtils.js';

/**
 * Props:
 * - isOpen: boolean
 * - onClose: function
 * - onSubmit: optional async function(payload) - nếu provided sẽ được gọi khi submit
 * - mediatorAddress: optional string - hiển thị address của mediator đang vote
 */
export default function MediatorVoteModal({ isOpen, onClose, onSubmit, mediatorAddress = null }) {
  const [choice, setChoice] = useState('RELEASE_TO_BUYER');
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  if (!isOpen) return null;


  const handleSignAndSubmit = async () => {
  setSubmitting(true);

  // Validate wallet & account
  if (!walletClient || !address) {
    alert('Wallet chưa kết nối. Vui lòng kết nối wallet để ký và submit vote.');
    setSubmitting(false);
    return;
  }

  // Ensure mediatorAddress provided (prop)
  const signerAddr = mediatorAddress || address;

  const votePayload = {
    mediator: signerAddr,
    vote: choice,
    justification,
    evidenceRefs: [], // nếu có evidence selection, gắn vào đây
    timestamp: new Date().toISOString(),
    disputeId: typeof disputeId !== 'undefined' ? disputeId : undefined,
    verifyingContract: undefined // nếu bạn có dispute contract address, set ở đây
  };

  try {
    // Tạo EIP-712 signature bằng signatureUtils (viem WalletClient)
    const signature = await signatureUtils.signVotePayload(walletClient, address, signerAddr, votePayload);

    // Gắn signature vào payload gửi về backend
    const submitPayload = {
      mediator: signerAddr,
      vote: choice,
      justification,
      evidenceRefs: votePayload.evidenceRefs,
      timestamp: votePayload.timestamp,
      signature
    };

    // Gọi API submitVote
    const targetDisputeId = typeof disputeId !== 'undefined' ? disputeId : '';
    if (!targetDisputeId) {
      console.warn('MediatorVoteModal: disputeId not provided; submitVote may fail.');
    }
    const res = await submitVote(targetDisputeId, submitPayload);
    console.log('[MediatorVoteModal] submitVote response:', res);
  } catch (err) {
    console.error('Vote submit failed', err);
    alert('Vote submit thất bại. Kiểm tra console để biết chi tiết.');
  } finally {
    setSubmitting(false);
    onClose?.();
  }
};
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !submitting && onClose?.()} />
      <div className="relative bg-white rounded-lg shadow-lg w-full max-w-lg mx-4">
        <div className="px-6 py-4 border-b">
          <h3 className="text-lg font-semibold text-gray-800">Mediator Vote</h3>
          <p className="text-sm text-gray-500 mt-1">Chọn outcome và ký bằng EIP-712 (mock signature trong UI này).</p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Vote Outcome</div>
            <div className="space-y-2">
              <label className="flex items-center space-x-3">
                <input type="radio" name="vote" value="RELEASE_TO_BUYER" checked={choice === 'RELEASE_TO_BUYER'} onChange={() => setChoice('RELEASE_TO_BUYER')} disabled={submitting} />
                <span className="text-sm">Release to Buyer</span>
              </label>
              <label className="flex items-center space-x-3">
                <input type="radio" name="vote" value="RETURN_TO_SELLER" checked={choice === 'RETURN_TO_SELLER'} onChange={() => setChoice('RETURN_TO_SELLER')} disabled={submitting} />
                <span className="text-sm">Return to Seller</span>
              </label>
              <label className="flex items-center space-x-3">
                <input type="radio" name="vote" value="SPLIT" checked={choice === 'SPLIT'} onChange={() => setChoice('SPLIT')} disabled={submitting} />
                <span className="text-sm">Split</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Justification</label>
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              className="mt-2 block w-full rounded-md border-gray-200 shadow-sm py-2 px-3 text-sm min-h-25"
              placeholder="Giải thích ngắn về quyết định của bạn..."
              disabled={submitting}
            />
          </div>

          <div className="p-3 bg-gray-50 rounded text-sm text-gray-600">
            <strong>Note:</strong> Khi Mediator submit, hệ thống yêu cầu một EIP-712 signature từ wallet để đảm bảo integrity của vote.
            Trong mock này chữ ký được giả lập và payload sẽ được logged ở console.
          </div>
        </div>

        <div className="px-6 py-4 border-t flex items-center justify-end space-x-3">
          <button
            onClick={() => !submitting && onClose?.()}
            className="px-4 py-2 rounded-md bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
            disabled={submitting}
          >
            Cancel
          </button>

          <button
            onClick={handleSignAndSubmit}
            className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700 flex items-center"
            disabled={submitting}
          >
            {submitting && <svg className="animate-spin mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/><path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" className="opacity-75"/></svg>}
            {submitting ? 'Signing...' : 'Sign & Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
// frontend/src/components/dispute/InitiateDisputeModal.jsx
// Modal để user khởi tạo Dispute.
// Comment bằng tiếng Việt; giữ nguyên các thuật ngữ IT/Web3 (Modal, UI/UX, payload, wallet).
import React, { useState } from 'react';

/**
 * Props:
 * - isOpen: boolean - hiển thị Modal hay không
 * - onClose: function - callback khi đóng Modal
 * - onSubmit: optional function(payload) - nếu provided sẽ được gọi khi submit (mock handler nếu không có)
 */
export default function InitiateDisputeModal({ isOpen, onClose, onSubmit }) {
  const [reason, setReason] = useState('PaymentIssue');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setSubmitting(true);
    const payload = {
      reason,
      description,
      createdAt: new Date().toISOString()
    };

    // Nếu có onSubmit prop, gọi nó; nếu không, console.log (mock handler)
    try {
      if (typeof onSubmit === 'function') {
        await onSubmit(payload);
      } else {
        // Mock submission: chỉ log payload
        console.log('[InitiateDisputeModal] mock submit payload:', payload);
        // giả lập delay
        await new Promise((r) => setTimeout(r, 800));
      }
    } catch (err) {
      console.error('Submit error', err);
    } finally {
      setSubmitting(false);
      if (typeof onClose === 'function') onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !submitting && onClose?.()} />
      <div className="relative bg-white rounded-lg shadow-lg w-full max-w-md mx-4">
        <div className="px-6 py-4 border-b">
          <h3 className="text-lg font-semibold text-gray-800">Initiate Dispute</h3>
          <p className="text-sm text-gray-500 mt-1">Điền thông tin để khởi tạo dispute (mock submission).</p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-2 block w-full rounded-md border-gray-200 shadow-sm py-2 px-3 text-sm"
              disabled={submitting}
            >
              <option value="PaymentIssue">Payment Issue</option>
              <option value="NonDelivery">Non-delivery</option>
              <option value="QualityIssue">Quality Issue</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-2 block w-full rounded-md border-gray-200 shadow-sm py-2 px-3 text-sm min-h-25"
              placeholder="Mô tả chi tiết tình huống..."
              disabled={submitting}
            />
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
            onClick={handleSubmit}
            className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700 flex items-center"
            disabled={submitting}
          >
            {submitting && (
              <svg className="animate-spin mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                <path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" className="opacity-75" />
              </svg>
            )}
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
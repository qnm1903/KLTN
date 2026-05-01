import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { DISPUTE_STATUS } from '../constants/dispute.constants.js';
import mockDataDefault, { mockDisputeList } from '../../../test/disputeMockData.js';

/**
 * DisputeList page
 *
 * - Hiển thị bảng/tiles các dispute từ mock data.
 * - Có filters: "My disputes", "Active", "Resolved", "Awaiting evidence".
 * - Mỗi row hiển thị id, escrowId, status badge, createdAt, và nút View Details (conceptual).
 */

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'My disputes' },
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'awaiting_evidence', label: 'Awaiting evidence' }
];

// Giả lập current user address cho filter "My disputes"
const CURRENT_USER_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function statusBadge(status) {
  // map status -> tailwind classes and label (giữ nguyên status text)
  switch (status) {
    case DISPUTE_STATUS.RESOLVED:
      return { label: status, cls: 'bg-green-100 text-green-800' };
    case DISPUTE_STATUS.PENDING_VRF:
    case DISPUTE_STATUS.VRF_FAILED:
      return { label: status, cls: 'bg-yellow-100 text-yellow-800' };
    case DISPUTE_STATUS.VOTING:
    case DISPUTE_STATUS.MEDIATORS_ASSIGNED:
      return { label: status, cls: 'bg-blue-100 text-blue-800' };
    case DISPUTE_STATUS.TIMED_OUT:
      return { label: status, cls: 'bg-red-100 text-red-800' };
    default:
      return { label: status, cls: 'bg-gray-100 text-gray-800' };
  }
}

export default function DisputeList() {
  const [filter, setFilter] = useState('all');
  const navigate = useNavigate();

  // Dùng mockDisputeList (imported từ frontend/test)
  const disputes = mockDisputeList || [];

  const filtered = useMemo(() => {
    switch (filter) {
      case 'mine':
        return disputes.filter((d) => d.initiatorAddress === CURRENT_USER_ADDRESS);
      case 'active':
        return disputes.filter((d) => d.status === DISPUTE_STATUS.PENDING_VRF || d.status === DISPUTE_STATUS.MEDIATORS_ASSIGNED || d.status === DISPUTE_STATUS.VOTING);
      case 'resolved':
        return disputes.filter((d) => d.status === DISPUTE_STATUS.RESOLVED);
      case 'awaiting_evidence':
        // concept: awaiting evidence = assigned but no evidence or special flag
        return disputes.filter((d) => (d.status === DISPUTE_STATUS.MEDIATORS_ASSIGNED || d.status === DISPUTE_STATUS.VOTING) && (!d.evidence || d.evidence.length === 0));
      case 'all':
      default:
        return disputes;
    }
  }, [filter, disputes]);

  return (
    <div className="max-w-7xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-800">Disputes</h1>
        <p className="text-sm text-gray-500 mt-1">Danh sách disputes (mock data) — sử dụng filters để thu hẹp kết quả.</p>
      </header>

      {/* Filters */}
      <div className="mb-4 flex items-center space-x-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1 rounded-full text-sm ${
              filter === f.key ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table / list */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500">ID</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500">Escrow</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500">Created At</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500">Actions</th>
            </tr>
          </thead>

          <tbody className="bg-white divide-y">
            {filtered.map((d) => {
              const badge = statusBadge(d.status);
              return (
                <tr key={d.disputeId}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700 font-mono">{d.disputeId}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{d.escrowId}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                    <button
                      onClick={() => navigate(`/disputes/${d.disputeId}`)}
                      className="px-3 py-1 rounded-md bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                    >
                      View Details
                    </button>
                  </td>
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td colSpan="5" className="px-6 py-8 text-center text-sm text-gray-500">
                  Không tìm thấy disputes theo filter hiện tại.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
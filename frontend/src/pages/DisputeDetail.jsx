import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentDisputeAtom, evidenceListAtom, mediatorsListAtom, voteTallyAtom } from '../store/disputeAtoms.js';
import VRFLoadingState from '../components/dispute/VRFLoadingState.jsx';
import EvidenceTimeline from '../components/dispute/EvidenceTimeline.jsx';
import MediatorPanel from '../components/dispute/MediatorPanel.jsx';

import mockDataDefault, { mockDisputeDetail, mockEvidenceList, mockMediators, mockVoteTally } from '../../test/disputeMockData.js';
import { DISPUTE_STATUS } from '../constants/dispute.constants.js';

/**
 * DisputeDetail page
 * - Đọc currentDisputeAtom để quyết định render state.
 * - Nếu status === PENDING_VRF -> hiển thị VRFLoadingState.
 * - Nếu MEDIATORS_ASSIGNED hoặc VOTING -> split layout: EvidenceTimeline (left) + MediatorPanel (right).
 * - useEffect inject mock data từ frontend/test/disputeMockData.js vào atoms để test UI.
 */
const DisputeDetail = () => {
  const current = useAtomValue(currentDisputeAtom);
  const setCurrent = useSetAtom(currentDisputeAtom);
  const setEvidence = useSetAtom(evidenceListAtom);
  const setMediators = useSetAtom(mediatorsListAtom);
  const setTally = useSetAtom(voteTallyAtom);

  // Inject mock data on mount for UI testing (chỉ khi currentDispute chưa tồn tại)
  useEffect(() => {
    if (!current) {
      // Sử dụng mockDisputeDetail, mockEvidenceList, mockMediators, mockVoteTally
      setCurrent(mockDisputeDetail);
      setEvidence(mockEvidenceList);
      setMediators(mockMediators);
      setTally(mockVoteTally);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = current ? current.status : DISPUTE_STATUS.PENDING_VRF;

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* Header */}
      <header className="mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-800">Dispute Detail</h1>
          <div className="text-sm text-gray-600">
            Status:{' '}
            <span className="px-3 py-1 bg-gray-100 rounded text-sm">
              {status}
            </span>
          </div>
        </div>
        <p className="text-sm text-gray-500 mt-2">Thông tin chi tiết dispute, evidence và mediator panel.</p>
      </header>

      {/* Main content */}
      <main>
        {status === DISPUTE_STATUS.PENDING_VRF ? (
          <div className="mb-6">
            <VRFLoadingState requestId={current?.requestId} txHash={current?.onChainTxHash} />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left / Center: Evidence (span 2 cols on large) */}
            <div className="lg:col-span-2">
              <div className="mb-4">
                <h3 className="text-lg font-medium text-gray-800">Evidence Timeline</h3>
                <p className="text-sm text-gray-500">Danh sách Evidence đã upload (off-chain/IPFS).</p>
              </div>
              <EvidenceTimeline />
            </div>

            {/* Right: Mediator Panel */}
            <div>
              <MediatorPanel />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default DisputeDetail;
import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  currentDisputeAtom,
  evidenceListAtom,
  mediatorsListAtom,
  voteTallyAtom
} from '../store/disputeAtoms.js';

// Import mock data (dùng cho UI testing / dev mode)
import {
  mockDisputeDetail,
  mockEvidenceList,
  mockMediators,
  mockVoteTally
} from '../../test/disputeMockData.js';

/**
 * useDisputeDetail
 *
 * - Centralizes access to Dispute-related Jotai atoms.
 * - Khi hook mount và nếu chưa có data, hook sẽ inject mock data từ frontend/test/disputeMockData.js
 *   để tiện development / visual QA trước khi backend tích hợp.
 *
 * Trả về:
 * {
 *   currentDispute, // object or null
 *   status,         // currentDispute?.status or null
 *   evidence,       // array of Evidence
 *   mediators,      // array of Mediator (7 slots when assigned)
 *   tally           // VoteTally object
 * }
 */
export default function useDisputeDetail() {
  // Đọc giá trị hiện trạng bằng useAtomValue (readonly)
  const currentDispute = useAtomValue(currentDisputeAtom);
  const evidence = useAtomValue(evidenceListAtom);
  const mediators = useAtomValue(mediatorsListAtom);
  const tally = useAtomValue(voteTallyAtom);

  // Setter để inject mock data khi cần
  const setCurrentDispute = useSetAtom(currentDisputeAtom);
  const setEvidence = useSetAtom(evidenceListAtom);
  const setMediators = useSetAtom(mediatorsListAtom);
  const setTally = useSetAtom(voteTallyAtom);

  // Inject mock data on mount if atoms are empty (dev convenience)
  useEffect(() => {
    // Nếu currentDispute chưa tồn tại, inject mock dataset
    if (!currentDispute) {
      // Lưu ý: production code nên có flag cho mock (e.g., process.env.NODE_ENV === 'development')
      try {
        setCurrentDispute(mockDisputeDetail);
        setEvidence(mockEvidenceList);
        setMediators(mockMediators);
        setTally(mockVoteTally);
      } catch (err) {
        // Nếu có lỗi khi inject mock data, log để dev biết
        // Không throw để tránh crash UI
        // eslint-disable-next-line no-console
        console.error('useDisputeDetail: failed to inject mock data', err);
      }
    }
    // Chỉ chạy 1 lần khi mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive status for convenience
  const status = currentDispute ? currentDispute.status : null;

  // Trả về object theo yêu cầu để component tiêu thụ
  return {
    currentDispute,
    status,
    evidence,
    mediators,
    tally
  };
}
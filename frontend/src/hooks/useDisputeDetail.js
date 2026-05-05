import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  currentDisputeAtom,
  evidenceListAtom,
  mediatorsListAtom,
  voteTallyAtom
} from '../store/disputeAtoms.js';

// 1. Nhập api instance từ lib (Đã xoá import mock data)
import api from '../lib/api.js';

/**
 * useDisputeDetail
 *
 * - Nhận vào disputeId từ URL.
 * - Gọi API Backend để lấy dữ liệu thực tế.
 * - Cập nhật vào Jotai atoms.
 */
export default function useDisputeDetail(disputeId) {
  // Đọc giá trị hiện trạng bằng useAtomValue
  const currentDispute = useAtomValue(currentDisputeAtom);
  const evidence = useAtomValue(evidenceListAtom);
  const mediators = useAtomValue(mediatorsListAtom);
  const tally = useAtomValue(voteTallyAtom);

  // Setter để cập nhật data thật
  const setCurrentDispute = useSetAtom(currentDisputeAtom);
  const setEvidence = useSetAtom(evidenceListAtom);
  const setMediators = useSetAtom(mediatorsListAtom);
  const setTally = useSetAtom(voteTallyAtom);

  // 2. Fetch dữ liệu thật thay vì Mock Data
  useEffect(() => {
    // Nếu không có disputeId (chưa load URL kịp), bỏ qua
    if (!disputeId) return;

    const fetchRealDisputeData = async () => {
      try {
        // Sử dụng api.js đã được cấu hình interceptors
        const response = await api.get(`/disputes/${disputeId}`);
        const data = response.data;

        // Đổ dữ liệu thật từ Backend vào Global State (Jotai)
        setCurrentDispute(data);
        setEvidence(data.evidence || []);
        setMediators(data.mediators || []);
        
        // Cập nhật tally, dự phòng nếu backend trả về null/undefined
        setTally(data.currentTally || {
          RELEASE_TO_BUYER: 0,
          RETURN_TO_SELLER: 0,
          SPLIT: 0,
          OTHER: 0,
          totalVotes: 0,
          threshold: 5
        });
      } catch (err) {
        console.error('Lỗi khi fetch dữ liệu Dispute từ Backend:', err);
      }
    };

    fetchRealDisputeData();
    
    // Khối code mock data trước đó đã bị xóa hoàn toàn.
  }, [disputeId, setCurrentDispute, setEvidence, setMediators, setTally]);

  // Derive status
  const status = currentDispute ? currentDispute.status : null;

  return {
    currentDispute,
    status,
    evidence,
    mediators,
    tally
  };
}
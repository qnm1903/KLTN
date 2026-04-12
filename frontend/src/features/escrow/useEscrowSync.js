import { useEffect, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { 
  signatureProgressAtom, 
  signedNodesAtom, 
  addSystemLogAtom,
  escrowStatusAtom
} from './escrowStore';
import {socket} from '../../lib/socket'; 

/**
 * Custom Hook xử lý đồng bộ Socket.io và Optimistic UI Updates
 */
export const useEscrowSync = (escrowId) => {
  const [progress, setProgress] = useAtom(signatureProgressAtom);
  const [signedNodes, setSignedNodes] = useAtom(signedNodesAtom);
  const setStatus = useSetAtom(escrowStatusAtom);
  const addLog = useSetAtom(addSystemLogAtom);

  // Lắng nghe các sự kiện từ Relayer 
  useEffect(() => {
    if (!escrowId) return;

    // Join vào room riêng của giao dịch
    socket.emit('join_escrow', escrowId);
    addLog({ message: `Joined secure room for Escrow #${escrowId}`, type: 'success' });

    // Sự kiện: Có một node khác vừa ký thành công
    const handleSignatureUpdated = (data) => {
      const { nodeAddress, newProgress } = data;
      
      // Chỉ cập nhật nếu node này chưa có trong danh sách (tránh lặp)
      setSignedNodes((prev) => {
        if (prev.includes(nodeAddress)) return prev;
        return [...prev, nodeAddress];
      });
      
      setProgress(newProgress);
      addLog({ message: `Received valid signature share from ${nodeAddress.slice(0, 6)}...`, type: 'info' });

      if (newProgress >= 5) {
        setStatus('completed');
        addLog({ message: `Threshold reached (5/7). Ready to execute release!`, type: 'success' });
      }
    };

    socket.on('signature_updated', handleSignatureUpdated);

    // Dọn dẹp listener khi component unmount
    return () => {
      socket.off('signature_updated', handleSignatureUpdated);
      socket.emit('leave_escrow', escrowId);
    };
  }, [escrowId, setProgress, setSignedNodes, setStatus, addLog]);

  /**
   * Hàm gửi chữ ký lên server với cơ chế Optimistic UI và Acknowledgement
   * @param {string} userAddress - Địa chỉ ví của người đang ký
   * @param {string} signatureShare - Phân mảnh chữ ký vừa tính toán từ Web Worker
   */
  const submitSignature = useCallback(async (userAddress, signatureShare) => {
    // 1. Optimistic UI: Cập nhật UI ngay lập tức cho user có cảm giác mượt mà
    setSignedNodes((prev) => [...prev, userAddress]);
    setProgress((prev) => prev + 1);
    addLog({ message: `Submitting your signature share to Relayer...`, type: 'warning' });

    // 2. Gửi qua Socket kèm Callback (Acknowledgement) để xác nhận từ Server
    return new Promise((resolve, reject) => {
      // Set timeout 10 giây nếu server không phản hồi
      const timeoutId = setTimeout(() => {
        rollbackUI();
        reject(new Error('Request timeout. Relayer did not respond.'));
      }, 10000);

      socket.emit('submit_signature', { escrowId, userAddress, signatureShare }, (response) => {
        clearTimeout(timeoutId);
        
        if (response.status === 'success') {
          // Server xác nhận hợp lệ
          addLog({ message: `Signature accepted and verified by Relayer.`, type: 'success' });
          resolve(response.data);
        } else {
          // Server từ chối (Ví dụ: Chữ ký sai toán học)
          rollbackUI();
          addLog({ message: `Signature rejected: ${response.error}`, type: 'error' });
          reject(new Error(response.error));
        }
      });
    });

    // 3. Hàm Rollback: Phục hồi lại trạng thái cũ nếu gửi thất bại
    function rollbackUI() {
      setSignedNodes((prev) => prev.filter(addr => addr !== userAddress));
      setProgress((prev) => prev - 1);
    }
  }, [escrowId, setProgress, setSignedNodes, addLog]);

  return { submitSignature };
};
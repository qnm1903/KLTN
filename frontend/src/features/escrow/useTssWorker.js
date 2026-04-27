import { useEffect, useRef, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { addSystemLogAtom } from './escrowStore';
import { saveNonceRecord, getNonceRecord, clearNonceRecord } from '../../lib/storage';

/**
 * Custom Hook quản lý vòng đời và giao tiếp với TSS Web Worker
 */
export const useTssWorker = () => {
  // Dùng useRef để giữ instance của worker không bị re-create mỗi khi component render lại
  const workerRef = useRef(null);
  const taskResolvers = useRef({});
  const addLog = useSetAtom(addSystemLogAtom); // Lấy hàm ghi log lên Terminal UI

  // Khởi tạo Worker khi component mount
  const persistNonce = useCallback(async (nonceKey, nonceHex) => {
    if (!nonceKey || !nonceHex) return;
    console.log(`[TSS Worker Main] Saving nonce: ${nonceKey}`);
    
    // Check if nonce already exists to prevent overwrite
    const existingNonce = await getNonceRecord(nonceKey);
    if (existingNonce) {
      console.log(`[TSS Worker Main] Nonce already exists, skipping overwrite: ${nonceKey}`);
      return; // Don't overwrite existing nonce
    }
    
    await saveNonceRecord(nonceKey, nonceHex);
  }, []);

  const loadNonce = useCallback(async (nonceKey) => {
    if (!nonceKey) return null;
    console.log(`[TSS Worker Main] Loading nonce: ${nonceKey}`);
    const nonceHex = await getNonceRecord(nonceKey);
    console.log(`[TSS Worker Main] Loaded nonce: ${nonceHex ? 'FOUND' : 'NOT FOUND'}`);
    return nonceHex;
  }, []);

  const clearNonce = useCallback(async (nonceKey) => {
    if (!nonceKey) return;
    await clearNonceRecord(nonceKey);
  }, []);

  const hasNonce = useCallback(async (nonceKey) => {
    if (!nonceKey) return false;
    const nonceHex = await getNonceRecord(nonceKey);
    return Boolean(nonceHex);
  }, []);

  useEffect(() => {
    // Cú pháp chuẩn của Vite để import Web Worker
    workerRef.current = new Worker(new URL('./tss.worker.js', import.meta.url), {
      type: 'module',
    });

    // Lắng nghe kết quả trả về từ Worker
    workerRef.current.onmessage = (event) => {
      const { taskId, status, result, error, log } = event.data;

      // In log ra UI Terminal 
      if (log) {
        addLog({ 
          message: `[TSS Worker] ${log}`, 
          type: status === 'error' ? 'error' : 'info' 
        });
      }

      if (taskResolvers.current[taskId]) {
        if (status === 'success') {
          taskResolvers.current[taskId].resolve(result);
          delete taskResolvers.current[taskId];
        } else if (status === 'error') {
          taskResolvers.current[taskId].reject(new Error(error));
          delete taskResolvers.current[taskId];
        }
      }
    };

    // Dọn dẹp Worker khi component unmount
    return () => {
      workerRef.current?.terminate();
    };
  }, [addLog]); // Thêm addLog vào dependency array

  // Hàm gọi Worker dưới dạng Promise để dùng dễ dàng với async/await trong React
  const executeWorkerTask = useCallback((action, payload) => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker is not initialized'));
        return;
      }

      // Tạo ID duy nhất cho mỗi luồng tính toán
      const taskId = crypto.randomUUID();
      taskResolvers.current[taskId] = { resolve, reject };

      // Gửi lệnh xuống luồng ngầm
      workerRef.current.postMessage({ action, payload, taskId });
    });
  }, []);

  return {
    // Chuẩn hóa hàm export đúng Signing Happy Path 
    computeNonce: async (nonceKey) => {
      const result = await executeWorkerTask('COMPUTE_NONCE', { nonceKey });
      await persistNonce(nonceKey, result?.nonceHex);
      return result;
    },
    computeZShare: async (privateKeyHex, challengeHex, nonceKey) => {
      console.log(`[TSS Worker Main] computeZShare called with nonceKey: ${nonceKey}`);
      const nonceHex = await loadNonce(nonceKey);
      console.log(`[TSS Worker Main] computeZShare nonceHex: ${nonceHex}`);
      const result = await executeWorkerTask('COMPUTE_Z_SHARE', { privateKeyHex, challengeHex, nonceKey, nonceHex });
      await clearNonce(nonceKey);
      return result;
    },
    hasNonce
  };
};

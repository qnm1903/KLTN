import { useEffect, useRef, useCallback, useMemo } from 'react';
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
  const persistNonce = useCallback(async (nonceKey, nonceHex, frostExtras) => {
    if (!nonceKey) return;
    console.log(`[TSS Worker Main] Saving nonce: ${nonceKey}`);

    // Don't overwrite an existing nonce (idempotent)
    const existingNonce = await getNonceRecord(nonceKey);
    if (existingNonce) {
      console.log(`[TSS Worker Main] Nonce already exists, skipping overwrite: ${nonceKey}`);
      return;
    }

    await saveNonceRecord(nonceKey, nonceHex, frostExtras);
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

// Dọn dẹp Worker và giải phóng các Promise đang kẹt khi component unmount
    return () => {
      try {
        // Reject toàn bộ task đang chờ để tránh memory leak
        Object.values(taskResolvers.current).forEach(({ reject }) => {
          try {
            reject(new Error('TSS worker terminated forcefully on unmount'));
          } catch { /* ignore rejection errors during cleanup */ }
        });
        taskResolvers.current = {};
        
        // Ngắt liên kết nhận tin nhắn trước khi hủy luồng để tránh orphaned callbacks
        if (workerRef.current) {
          workerRef.current.onmessage = null;
          workerRef.current.terminate();
        }
        workerRef.current = null;
      } catch (e) {
        console.warn('[TSS Worker] Cleanup warning:', e);
      }
    };
  }, [addLog]); 

  // Hàm gọi Worker dưới dạng Promise để dùng dễ dàng với async/await trong React

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

  return useMemo(() => ({
    computeNonce: async (nonceKey) => {
      const existing = await loadNonce(nonceKey);
      // existing is string (legacy) or null
      const existingNonceHex = typeof existing === 'string' ? existing : null;
      if (existingNonceHex) {
        console.log(`[TSS Worker Main] Reusing existing nonce from IndexedDB: ${nonceKey}`);
        return await executeWorkerTask('COMPUTE_NONCE_FROM_EXISTING', { nonceKey, nonceHex: existingNonceHex });
      }

      const result = await executeWorkerTask('COMPUTE_NONCE', { nonceKey });
      await persistNonce(nonceKey, result?.nonceHex);
      return result;
    },
    computeNonceFrost: async (nonceKey) => {
      const existing = await loadNonce(nonceKey);
      // Existing may be object with k1Hex, k2Hex from a previous FROST run
      if (existing && typeof existing === 'object' && existing.k1Hex && existing.k2Hex) {
        console.log(`[TSS Worker Main] Reusing existing FROST nonces from IndexedDB: ${nonceKey}`);
        // Restore k1/k2 into worker memory via two COMPUTE_NONCE_FROM_EXISTING-style calls
        // Re-derive R1, R2 from stored k1, k2
        const kp1 = await executeWorkerTask('COMPUTE_NONCE_FROM_EXISTING', { nonceKey: nonceKey + ':k1', nonceHex: existing.k1Hex });
        const kp2 = await executeWorkerTask('COMPUTE_NONCE_FROM_EXISTING', { nonceKey: nonceKey + ':k2', nonceHex: existing.k2Hex });
        return {
          R1_x: kp1.R_x, R1_y: kp1.R_y,
          R2_x: kp2.R_x, R2_y: kp2.R_y,
          k1Hex: existing.k1Hex, k2Hex: existing.k2Hex,
        };
      }

      const result = await executeWorkerTask('COMPUTE_NONCE_FROST', { nonceKey });
      // Save both k1 and k2
      await persistNonce(nonceKey, null, { k1Hex: result.k1Hex, k2Hex: result.k2Hex });
      return result;
    },
    computeZShare: async (privateKeyHex, challengeHex, nonceKey, bindingFactorHex, k1Hex, k2Hex) => {
      console.log(`[TSS Worker Main] computeZShare called with nonceKey: ${nonceKey}, FROST: ${!!bindingFactorHex}`);
      const nonceRecord = await loadNonce(nonceKey);
      const nonceHex = typeof nonceRecord === 'string' ? nonceRecord : null;
      const result = await executeWorkerTask('COMPUTE_Z_SHARE', {
        privateKeyHex, challengeHex, nonceKey, nonceHex,
        bindingFactorHex: bindingFactorHex || null,
        k1Hex: k1Hex || (typeof nonceRecord === 'object' ? nonceRecord?.k1Hex : null),
        k2Hex: k2Hex || (typeof nonceRecord === 'object' ? nonceRecord?.k2Hex : null),
      });
      // KHÔNG xóa nonce ngay: cho phép tính lại Z-Share (idempotent) trên cùng challenge.
      // Nonce chỉ bị xóa khi reset signing hoặc khi ký hoàn tất — tránh "FROST nonces not found".
      return result;
    },
    // Raw task executor — dùng cho useDkgPhase và các use cases nâng cao
    executeWorkerTask,
    // Exposed so EscrowDetail can clear a stale nonce when a mismatch with the backend is detected
    clearNonce,
    hasNonce
  }), [loadNonce, executeWorkerTask, persistNonce, clearNonce, hasNonce]);
};

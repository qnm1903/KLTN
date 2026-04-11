import { useEffect, useRef, useCallback } from 'react';

/**
 * Custom Hook quản lý vòng đời và giao tiếp với TSS Web Worker
 */
export const useTssWorker = () => {
  // Dùng useRef để giữ instance của worker không bị re-create mỗi khi component render lại
  const workerRef = useRef(null);
  const taskResolvers = useRef({});

  // Khởi tạo Worker khi component mount
  useEffect(() => {
    // Cú pháp chuẩn của Vite để import Web Worker
    workerRef.current = new Worker(new URL('./tss.worker.js', import.meta.url), {
      type: 'module',
    });

    // Lắng nghe kết quả trả về từ Worker
    workerRef.current.onmessage = (event) => {
      const { taskId, status, result, error, log } = event.data;

      // In log ra console để GVHD thấy quá trình chạy ngầm
      if (log) console.log(`[TSS Worker Log]: ${log}`);

      if (taskResolvers.current[taskId]) {
        if (status === 'success') {
          taskResolvers.current[taskId].resolve(result);
          delete taskResolvers.current[taskId];
        } else if (status === 'error') {
          taskResolvers.current[taskId].reject(new Error(error));
          delete taskResolvers.current[taskId];
        }
        // Nếu status là 'computing', ta có thể bỏ qua hoặc bắn event update UI progress
      }
    };

    // Dọn dẹp Worker khi component unmount (Chống rò rỉ bộ nhớ - Memory Leak)
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

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
    // Expose các hàm chức năng cụ thể ra ngoài
    initDkg: (mediators) => executeWorkerTask('INIT_DKG', { mediators }),
    generateSignatureShare: (escrowId, privateKeyShare) => 
      executeWorkerTask('GENERATE_SIGNATURE_SHARE', { escrowId, privateKeyShare })
  };
};
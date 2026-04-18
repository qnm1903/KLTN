/**
 * Kiến trúc Web Worker xử lý Mật mã học TSS 5-of-7
 * Mục đích học thuật: Offload tính toán đường cong Elliptic nặng khỏi Main Thread của React,
 * tránh tình trạng Freeze UI trong quá trình ký.
 */

// Hàm giả lập tính toán nặng (Mô phỏng phép nhân điểm trên secp256k1)
const simulateHeavyECC = (complexity = 15000000) => {
  let result = 0;
  for (let i = 0; i < complexity; i++) {
    result += Math.sqrt(i) * Math.sin(i);
  }
  return result;
};

// Hàm sinh mã Hex ngẫu nhiên (Mock dữ liệu thực tế)
const generateMockHex = (length = 64) => {
  return "0x" + Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
};

self.onmessage = async (event) => {
  const { action, taskId, payload } = event.data;

  try {
    switch (action) {
      case 'COMPUTE_NONCE': {
        // Round 1: Sinh số ngẫu nhiên k (Cryptographic Nonce) và tính R = k * G
        self.postMessage({ taskId, status: 'computing', log: 'Đang sinh số ngẫu nhiên k và tính toán Nonce R = k*G...' });
        
        simulateHeavyECC(10000000); // Mô phỏng trễ
        
        // Theo chuẩn DTO của nhánh Main, backend cần R_x và R_y (Tọa độ của điểm R)
        const R_x = generateMockHex(64);
        const R_y = generateMockHex(64);

        self.postMessage({
          taskId,
          status: 'success',
          result: { R_x, R_y },
          log: 'Đã hoàn tất tính toán Nonce (Round 1).'
        });
        break;
      }

      case 'COMPUTE_Z_SHARE': {
        // Round 2: Tính toán Z-Share dựa trên k_i (lưu cục bộ), x_i (khóa riêng), e (challenge) và R_agg
        self.postMessage({ taskId, status: 'computing', log: 'Đang giải phương trình Schnorr: z_i = k_i + e * x_i...' });
        
        simulateHeavyECC(15000000); // Mô phỏng trễ

        // Theo chuẩn DTO, backend cần mảnh z_i
        const z = generateMockHex(64);

        self.postMessage({
          taskId,
          status: 'success',
          result: { z },
          log: 'Đã hoàn tất tính toán Partial Signature (Z-Share - Round 2).'
        });
        break;
      }

      default:
        throw new Error(`Unknown action specified for TSS Worker: ${action}`);
    }
  } catch (error) {
    self.postMessage({
      taskId,
      status: 'error',
      error: error.message,
      log: `Worker Error: ${error.message}`
    });
  }
};
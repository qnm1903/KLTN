/**
 * Kiến trúc Web Worker xử lý Mật mã học TSS (Threshold Signature Scheme)
 * Mục đích học thuật: Offload tính toán ECC nặng khỏi Main Thread, chống UI blocking.
 */

// Hàm giả lập thuật toán mã hóa đường cong elip (ECC) sinh tải nặng cho CPU
// Trong thực tế, đây là nơi tích hợp thư viện 'elliptic' hoặc 'ethers.js'
const simulateHeavyECC = (complexity = 10000000) => {
  let result = 0;
  for (let i = 0; i < complexity; i++) {
    result += Math.sqrt(i) * Math.sin(i);
  }
  return result;
};

// Lắng nghe thông điệp từ Main Thread (React)
self.onmessage = async (event) => {
  const { action, taskId } = event.data;

  try {
    switch (action) {
      case 'INIT_DKG': {
        // Giai đoạn 1: Distributed Key Generation (Tạo khóa phân tán)
        self.postMessage({ taskId, status: 'computing', log: 'Starting ECC Key Generation...' });

        // Giả lập tính toán nặng mất khoảng 2-3 giây
        simulateHeavyECC(30000000);

        const mockPkAggCoords = "0x" + Math.random().toString(16).slice(2, 66); // Fake 32-byte hex

        self.postMessage({
          taskId,
          status: 'success',
          result: { pkAggCoords: mockPkAggCoords },
          log: 'DKG Completed successfully.'
        });
        break;
      }

      case 'GENERATE_SIGNATURE_SHARE': {
        // Giai đoạn 2: Tạo mảnh chữ ký (Signature Share)
        self.postMessage({ taskId, status: 'computing', log: 'Calculating Schnorr signature share...' });

        simulateHeavyECC(15000000); // Tính toán nhẹ hơn DKG một chút

        const mockSignatureShare = "0x" + Math.random().toString(16).slice(2, 66);

        self.postMessage({
          taskId,
          status: 'success',
          result: { signatureShare: mockSignatureShare },
          log: 'Signature share generated.'
        });
        break;
      }

      default:
        throw new Error('Unknown action specified for TSS Worker');
    }
  } catch (error) {
    self.postMessage({
      taskId,
      status: 'error',
      error: error.message,
      log: `Error: ${error.message}`
    });
  }
};
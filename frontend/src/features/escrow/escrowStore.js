import { atom } from 'jotai';

// 1. Trạng thái tổng thể của quá trình ký quỹ
// Các giá trị có thể: 'dkg_ready', 'computing_keys', 'signing', 'completed', 'error'
export const escrowStatusAtom = atom('dkg_ready');

// 2. Bộ đếm tiến trình chữ ký (0/7 đến 5/7)
export const signatureProgressAtom = atom(0);

// 3. Danh sách các địa chỉ ví đã ký (để hiển thị UI ai đã ký, ai chưa)
export const signedNodesAtom = atom([]);

// 4. Mảng lưu trữ log để hiển thị trên "Cửa sổ Terminal"
export const systemLogsAtom = atom([
  { time: new Date().toLocaleTimeString(), message: 'System initialized. Waiting for participants...', type: 'info' }
]);

// 5. Trạng thái lỗi (nếu có) để hiển thị Alert
export const escrowErrorAtom = atom(null);

/**
 * Action Atom (Hàm tiện ích để thêm log mới vào Terminal)
 * Cách dùng: const addLog = useSetAtom(addSystemLogAtom);
 */
export const addSystemLogAtom = atom(
  null,
  (get, set, newLog) => {
    const currentLogs = get(systemLogsAtom);
    const logEntry = {
      time: new Date().toLocaleTimeString(),
      message: newLog.message,
      type: newLog.type || 'info' // 'info', 'success', 'warning', 'error'
    };
    // Giữ lại tối đa 50 dòng log gần nhất để tránh tràn bộ nhớ
    set(systemLogsAtom, [...currentLogs, logEntry].slice(-50));
  }
);
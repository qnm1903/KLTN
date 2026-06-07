import { io } from 'socket.io-client';

// Khởi tạo kết nối tới cổng 3001 của Backend
// Tạm thời tắt autoConnect để chúng ta tự điều khiển thời điểm kết nối (khi vào trang Detail)
export const socket = io('http://localhost:3001', {
  autoConnect: false,
});

// ==========================================
// BẮT ĐẦU THÊM MỚI: GUARDED SOCKET ROOM LOGIC
// ==========================================

// Track joined rooms to prevent duplicate emits and listener memory leaks
export const _joinedEscrowRooms = new Set();

export async function joinEscrowRoom(escrowId, token) {
  if (!escrowId) return { ok: false, error: 'escrowId required' };
  
  if (!_joinedEscrowRooms.has(escrowId)) {
    _joinedEscrowRooms.add(escrowId);
    
    if (!socket.connected) socket.connect();
    
    return new Promise((resolve) => {
      socket.emit('join_escrow', { escrowId, token }, (response) => {
        // Revert local state if server rejects the join
        if (!response?.ok) _joinedEscrowRooms.delete(escrowId);
        resolve(response || { ok: false });
      });
    });
  }
  return { ok: true }; // Already joined, safely ignore
}

export function leaveEscrowRoom(escrowId) {
  if (!escrowId) return;
  _joinedEscrowRooms.delete(escrowId);
  try { 
    socket.emit('leave_escrow', escrowId); 
  } catch (e) { 
    console.warn('[Socket] Failed to leave room', e); 
  }
}
import { io } from 'socket.io-client';

// Khởi tạo kết nối tới cổng 3001 của Backend
// Tạm thời tắt autoConnect để chúng ta tự điều khiển thời điểm kết nối (khi vào trang Detail)
export const socket = io('http://localhost:3001', {
  autoConnect: false,
});
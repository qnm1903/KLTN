import { atom } from 'jotai';

// Khởi tạo state đọc từ localStorage nếu user đã F5 lại trang
const token = localStorage.getItem('jwt_token');

export const authAtom = atom({
  isAuthenticated: !!token,
  user: null, // Sẽ chứa { id, walletAddress, role }
});
import axios from 'axios';
import { getStoredAccessToken, clearSession } from '../store/authStore';

/**
 * Cấu hình Axios Instance với cơ chế tự động tiêm JWT Token vào Header.
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// REQUEST INTERCEPTOR: Gắn Token vào mọi yêu cầu đi tới Backend
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  
  if (token && token !== 'null' && token !== 'undefined') {
    // Sử dụng headers.set để đảm bảo tính tương thích với Axios v1.x
    if (config.headers && typeof config.headers.set === 'function') {
      config.headers.set('Authorization', `Bearer ${token}`);
    } else {
      config.headers.Authorization = `Bearer ${token}`;
    }
    console.log(`📡 [API Call]: ${config.method?.toUpperCase()} ${config.url} (Token Injected)`);
  }
  
  return config;
}, (error) => Promise.reject(error));

// RESPONSE INTERCEPTOR: Xử lý khi Token hết hạn (401)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.warn("🚨 [401 Unauthorized]: Phiên đăng nhập hết hạn hoặc Token không hợp lệ.");
      clearSession(); // Xóa sạch LocalStorage để bắt user login lại
    }
    return Promise.reject(error);
  }
);

export default api;
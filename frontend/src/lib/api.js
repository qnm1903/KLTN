import axios from 'axios';
import { getStoredAccessToken, clearSession } from '../store/authStore';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// INTERCEPTOR: Tự động gắn Authorization Header
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  
  if (token && token !== 'null' && token !== 'undefined') {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  
  return config;
}, (error) => Promise.reject(error));

// Xử lý lỗi 401 tự động logout
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.error("🚨 Unauthorized access - Clearing session");
      clearSession();
      // Không tự động reload để tránh loop, để UI handle trạng thái logout
    }
    return Promise.reject(error);
  }
);

export default api;
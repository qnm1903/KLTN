import axios from 'axios';
import { getStoredAccessToken, clearSession } from '../store/authStore';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// REQUEST INTERCEPTOR: Tiêm JWT Token tự động (Implicit Token Injection)
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  
  if (token && token !== 'null' && token !== 'undefined') {
    if (config.headers && typeof config.headers.set === 'function') {
      config.headers.set('Authorization', `Bearer ${token}`);
    } else {
      config.headers.Authorization = `Bearer ${token}`;
    }
    console.log(`📡 [API Call]: ${config.method?.toUpperCase()} ${config.url} (Secured)`);
  }
  
  return config;
}, (error) => Promise.reject(error));

// RESPONSE INTERCEPTOR: Circuit Breaker cho lỗi 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.warn("🚨 [401 Unauthorized]: Phiên hết hạn. Đang làm sạch State...");
      clearSession();
    }
    return Promise.reject(error);
  }
);

export default api;
import axios from 'axios';
import { getStoredAccessToken, clearSession, setSession } from '../store/authStore';

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

// RESPONSE INTERCEPTOR: Refresh token khi 401
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        }).catch(err => {
          return Promise.reject(err);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        console.log("[Refresh Token]: Đang refresh access token...");
        const refreshRes = await api.post('/auth/refresh');
        const newAccessToken = refreshRes.data.accessToken || refreshRes.data.token;

        // Lưu access token mới
        setSession({ 
          accessToken: newAccessToken, 
          user: refreshRes.data.user 
        });

        // Retry original request với token mới
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        processQueue(null, newAccessToken);
        return api(originalRequest);
      } catch (refreshError) {
        console.error("[Refresh Failed]:", refreshError);
        processQueue(refreshError, null);
        clearSession();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
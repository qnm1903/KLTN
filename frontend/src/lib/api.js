import axios from 'axios';
import { getStoredAccessToken, getStoredRefreshToken, clearSession, setSession } from '../store/authStore';

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
    // If the refresh endpoint itself failed (or any request explicitly to /auth/refresh), don't try to refresh again
    if (originalRequest && originalRequest.url && originalRequest.url.includes('/auth/refresh')) {
      try {
        clearSession();
      } catch (e) {}
      // Redirect to login immediately to prevent loops
      if (typeof window !== 'undefined') {
        window.location.replace('/login');
      }
      return Promise.reject(error);
    }

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
        // Use the raw axios client to call refresh so we bypass this instance's interceptors
        const refreshRes = await axios.post(`${api.defaults.baseURL}/auth/refresh`, { refreshToken: getStoredRefreshToken() }, { withCredentials: true });

        const newAccessToken = refreshRes.data.accessToken || refreshRes.data.token;
        const newRefreshToken = refreshRes.data.refreshToken || null;

        // Update session with both new tokens
        setSession({ 
          accessToken: newAccessToken, 
          refreshToken: newRefreshToken, 
          user: refreshRes.data.user 
        });

        // Retry original request với token mới
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        processQueue(null, newAccessToken);
        return api(originalRequest);
      } catch (refreshError) {
        console.error("[Refresh Failed]:", refreshError);
        processQueue(refreshError, null);
        try {
          clearSession();
        } catch (e) {}
        if (typeof window !== 'undefined') {
          window.location.replace('/login');
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
import axios from 'axios';
import {
  clearSession,
  getStoredAccessToken,
  setSession,
} from '../store/authStore';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

let inFlightRefreshPromise = null;

async function refreshAccessToken() {
  const response = await axios.post(
    `${api.defaults.baseURL}/auth/refresh`,
    {},
    {
      withCredentials: true,
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const nextAccessToken = response.data?.accessToken || response.data?.token;
  if (!nextAccessToken) throw new Error('Refresh failed');
  setSession({ accessToken: nextAccessToken, user: response.data?.user || null });
  return nextAccessToken;
}

// INTERCEPTOR: Tự động gắn Token vào Header
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  
  // Chỉ gắn nếu token tồn tại và không phải chuỗi rỗng
  if (token && token !== 'null' && token !== 'undefined') {
    config.headers = config.headers || {};
    config.headers['Authorization'] = `Bearer ${token}`;
    console.log(`📡 [Axios] Gắn Header Auth cho: ${config.url}`);
  }
  return config;
}, (error) => Promise.reject(error));

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        if (!inFlightRefreshPromise) {
          inFlightRefreshPromise = refreshAccessToken().finally(() => {
            inFlightRefreshPromise = null;
          });
        }
        const nextToken = await inFlightRefreshPromise;
        originalRequest.headers['Authorization'] = `Bearer ${nextToken}`;
        return api(originalRequest);
      } catch (err) {
        clearSession();
        return Promise.reject(err);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
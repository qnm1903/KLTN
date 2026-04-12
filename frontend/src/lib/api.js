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
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );

  const { data } = response;
  const nextAccessToken = data?.accessToken || data?.token;

  if (!nextAccessToken) {
    throw new Error('Refresh endpoint did not return access token');
  }

  setSession({
    accessToken: nextAccessToken,
    user: data?.user || null,
  });

  return nextAccessToken;
}

// Interceptor: Tự động gắn token vào header nếu có
api.interceptors.request.use((config) => {
  const token = getStoredAccessToken();
  if (token) {
    if (config.headers && typeof config.headers.set === 'function') {
      config.headers.set('Authorization', `Bearer ${token}`);
    } else {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
}, (error) => {
  throw error;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const statusCode = error.response?.status;
    const originalRequest = error.config;

    if (!originalRequest) {
      throw error;
    }

    const isUnauthorized = statusCode === 401;
    const isRefreshCall = typeof originalRequest.url === 'string' && originalRequest.url.includes('/auth/refresh');
    const wasRetried = !!originalRequest._retry;

    if (!isUnauthorized || isRefreshCall || wasRetried) {
      throw error;
    }

    originalRequest._retry = true;

    try {
      if (!inFlightRefreshPromise) {
        inFlightRefreshPromise = refreshAccessToken().finally(() => {
          inFlightRefreshPromise = null;
        });
      }

      const nextAccessToken = await inFlightRefreshPromise;

      if (originalRequest.headers && typeof originalRequest.headers.set === 'function') {
        originalRequest.headers.set('Authorization', `Bearer ${nextAccessToken}`);
      } else {
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${nextAccessToken}`;
      }

      return api(originalRequest);
    } catch {
      clearSession();
      throw error;
    }
  },
);

export default api;
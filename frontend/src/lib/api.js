import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3001/api', // Đã sửa thành 3001
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor: Tự động gắn token vào header nếu có
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('jwt_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});

export default api;
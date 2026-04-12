import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor: Tự động gắn token vào header nếu có
api.interceptors.request.use((config) => {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jwt_token') : null;
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

// Interceptor 2: Xử lý Response trả về từ Server
api.interceptors.response.use(
  (response) => {
    // Nếu API gọi thành công, trả về data bình thường
    return response;
  },
  (error) => {
    // Xử lý bảo mật: Nếu Server báo lỗi 401 (Token hết hạn / Không hợp lệ)
    if (error.response && error.response.status === 401) {
      console.warn('Phiên đăng nhập đã hết hạn. Vui lòng ký lại SIWE.');
      
      // Xóa token cũ để dọn dẹp state
      if (typeof window !== 'undefined') {
        localStorage.removeItem('jwt_token');
        // Tùy chọn nâng cao: Có thể emit một event để Jotai biết và reset state kết nối
        window.dispatchEvent(new Event('session_expired'));
      }
    }
    return Promise.reject(error);
  }
);

export default api;
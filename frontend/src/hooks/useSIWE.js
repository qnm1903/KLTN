import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { useAtom } from 'jotai';
import { authAtom } from '../store/authStore';
import api from '../lib/api';

export function useSIWE() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const [auth, setAuth] = useAtom(authAtom);

  const login = async () => {
    try {
      if (!address) throw new Error("Vui lòng kết nối ví MetaMask trước!");

      // 1. Lấy Nonce từ Backend
      const { data: { nonce } } = await api.get(`/auth/nonce?address=${address}`);

      // 2. Yêu cầu MetaMask ký thông điệp (Khớp 100% với Backend)
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;
      const signature = await signMessageAsync({ message });

      // 3. Gửi chữ ký lên Backend để Verify
      const { data } = await api.post('/auth/verify', { address, signature });

      // 4. Lưu JWT và cập nhật State
      localStorage.setItem('jwt_token', data.token);
      setAuth({ isAuthenticated: true, user: data.user });
      
      console.log("Đăng nhập thành công!", data.user);
    } catch (error) {
      console.error("Lỗi đăng nhập:", error);
      disconnect(); // Ngắt kết nối ví nếu xác thực thất bại
    }
  };

  const logout = () => {
    localStorage.removeItem('jwt_token');
    setAuth({ isAuthenticated: false, user: null });
    disconnect();
  };

  return { login, logout, auth };
}
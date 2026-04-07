import { useConnection, useSignMessage, useDisconnect } from 'wagmi';
import { useAtom } from 'jotai';
import {
  authAtom,
  clearSession,
  setSession,
} from '../store/authStore';
import api from '../lib/api';

export function useSIWE() {
  const { address } = useConnection();
  const signMessage = useSignMessage();
  const disconnect = useDisconnect();
  const [auth] = useAtom(authAtom);

  const login = async () => {
    try {
      if (!address) throw new Error("Vui lòng kết nối ví MetaMask trước!");

      // 1. Lấy Nonce từ Backend
      const { data: { nonce } } = await api.get(`/auth/nonce?address=${address}`);

      // 2. Yêu cầu MetaMask ký thông điệp (Khớp 100% với Backend)
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;
      const signature = await signMessage.mutateAsync({ message });

      // 3. Gửi chữ ký lên Backend để Verify
      const { data } = await api.post('/auth/verify', { address, signature });

      // 4. Lưu Access + Refresh Token và cập nhật Auth State
      setSession({
        accessToken: data.accessToken || data.token,
        user: data.user,
      });

      return data;
    } catch (error) {
      console.error('Lỗi đăng nhập:', error);
      disconnect.mutate(); // Ngắt kết nối ví nếu xác thực thất bại
      throw error;
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.warn('Logout request failed, clearing local session anyway:', error);
    } finally {
      clearSession();
      disconnect.mutate();
    }
  };

  return { login, logout, auth };
}
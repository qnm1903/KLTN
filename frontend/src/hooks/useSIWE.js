import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { useAtom } from 'jotai';
import { authAtom, clearSession, setSession } from '../store/authStore';
import api from '../lib/api';

/**
 * Hook xử lý xác thực SIWE (Sign-In With Ethereum)
 * Đảm bảo tính nhất quán giữa chữ ký người dùng và xác thực phía Server.
 */
export function useSIWE() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();
  const [auth, setAuth] = useAtom(authAtom);

  const login = async () => {
    try {
      if (!address) throw new Error("Please connect your MetaMask wallet first!");

      // 1. Lấy Nonce từ Backend
      const nonceRes = await api.get(`/auth/nonce?address=${address.toLowerCase()}`);
      const nonce = nonceRes.data?.nonce || nonceRes.data;
      if (!nonce) throw new Error("Backend returned empty nonce!");

      // 2. Yêu cầu MetaMask ký thông điệp (Format chuẩn của nhánh main)
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;
      
      console.log("🚦 [SIWE] Requesting signature for message:", message);
      const signature = await signMessageAsync({ message });

      // 3. Gửi chữ ký lên Backend (BỔ SUNG THAM SỐ MESSAGE ĐỂ FIX LỖI 400)
      const { data } = await api.post('/auth/verify', { 
        address: address.toLowerCase(), 
        signature,
        message // Nhánh main cần message này để recover address
      });

      // 4. Lưu Session và cập nhật Auth State
      const accessToken = data.accessToken || data.token;
      setSession({
        accessToken,
        user: data.user,
      });

      setAuth({ isAuthenticated: true, user: data.user });
      
      console.log("✅ [SIWE] Authentication successful. Token stored.");
      return data;

    } catch (error) {
      console.error('❌ [SIWE Error]:', error.response?.data || error.message);
      clearSession();
      // CHỈ disconnect nếu lỗi nghiêm trọng, không tự động ngắt kết nối khi chỉ là lỗi verify
      // giúp user có thể nhấn Sign In lại dễ dàng.
      throw error;
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.warn('Logout request failed:', error);
    } finally {
      clearSession();
      setAuth({ isAuthenticated: false, user: null });
      await disconnectAsync();
    }
  };

  return { login, logout, auth };
}
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { useAtom } from 'jotai';
import { authAtom, clearSession, setSession } from '../store/authStore';
import api from '../lib/api';

export function useSIWE() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();
  const [auth, setAuth] = useAtom(authAtom);

  const login = async () => {
    try {
      if (!address) throw new Error("Vui lòng kết nối ví MetaMask trước!");

      const normalizedAddress = address.toLowerCase();
      
      console.log("🚦 [SIWE Step 1]: Lấy Nonce...");
      const nonceRes = await api.get(`/auth/nonce?address=${normalizedAddress}`);
      const nonce = nonceRes.data?.nonce || nonceRes.data;
      if (!nonce) throw new Error("Backend không trả về Nonce!");

      // Chuỗi thông điệp bắt buộc phải khớp 100% với Backend
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;

      console.log("🚦 [SIWE Step 3]: Chờ ký MetaMask...");
      const signature = await signMessageAsync({ message });

      console.log("🚦 [SIWE Step 5]: Gửi Payload (Address, Signature, Message) lên Verify...");
      const { data } = await api.post('/auth/verify', { 
        address: normalizedAddress, 
        signature,
        message 
      });

      // Lưu Token vào LocalStorage (Đồng bộ với DB mới của nhánh main)
      const validToken = data.accessToken || data.token;
      setSession({
        accessToken: validToken,
        user: data.user,
      });

      setAuth({ isAuthenticated: true, user: data.user });
      console.log("✅ [SIWE]: Trạng thái đăng nhập THÀNH CÔNG!");
      return data;

    } catch (error) {
      const errorDetail = error.response?.data?.error || error.response?.data || error.message;
      console.error('❌ [SIWE FAILED]:', errorDetail);
      clearSession();
      // Không gọi disconnectAsync() ở đây để giữ UX mượt mà
      throw new Error(typeof errorDetail === 'string' ? errorDetail : "Xác thực thất bại");
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.warn("Logout Backend failed, clearing local session.");
    } finally {
      clearSession();
      setAuth({ isAuthenticated: false, user: null });
      if (disconnectAsync) await disconnectAsync();
    }
  };

  return { login, logout, auth };
}
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { useAtom } from 'jotai';
import { authAtom, clearSession, setSession } from '../store/authStore';
import api from '../lib/api';

/**
 * Hook xử lý SIWE (Sign-In With Ethereum) - Phase Auth
 * Đảm bảo đồng bộ hóa tuyệt đối giữa Chữ ký của ví và Session của Backend.
 */
export function useSIWE() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();
  const [auth, setAuth] = useAtom(authAtom);

  const login = async () => {
    try {
      if (!address) throw new Error("Chưa kết nối ví MetaMask!");

      console.log("🚦 [SIWE Step 1]: Đang lấy Nonce cho:", address);
      const nonceRes = await api.get(`/auth/nonce?address=${address.toLowerCase()}`);
      const nonce = nonceRes.data?.nonce || nonceRes.data;

      // ĐỊNH DẠNG TIN NHẮN (Phải khớp 100% với logic Verify của Backend)
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;

      console.log("🚦 [SIWE Step 3]: Yêu cầu ký MetaMask...");
      const signature = await signMessageAsync({ message });
      console.log("🚦 [SIWE Step 4]: Ký thành công. Đang gửi xác thực...");

      // STEP 5: Gửi đầy đủ Payload để Backend recover địa chỉ
      const { data } = await api.post('/auth/verify', { 
        address: address.toLowerCase(), 
        signature,
        message // Bổ sung message để Backend ethers.verifyMessage
      });

      console.log("🚦 [SIWE Step 6]: Backend xác thực thành công!");

      // Lưu Session vào LocalStorage và State
      setSession({
        accessToken: data.accessToken || data.token,
        user: data.user,
      });

      setAuth({ isAuthenticated: true, user: data.user });
      return data;

    } catch (error) {
      const errorDetail = error.response?.data?.error || error.message;
      console.error('❌ [SIWE FAILED]:', errorDetail);
      clearSession();
      throw new Error(errorDetail);
    }
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch (e) {
      console.warn("Logout Backend fail, clearing local anyway.");
    } finally {
      clearSession();
      setAuth({ isAuthenticated: false, user: null });
      await disconnectAsync();
    }
  };

  return { login, logout, auth };
}
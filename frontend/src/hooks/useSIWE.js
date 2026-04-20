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
      if (!address) throw new Error("Wallet not connected");

      // Step 1: Lấy Nonce
      const nonceRes = await api.get(`/auth/nonce?address=${address.toLowerCase()}`);
      const nonce = nonceRes.data?.nonce || nonceRes.data;

      // Step 2: Định dạng Message (Theo đúng yêu cầu của nhánh main)
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;

      // Step 3: Ký
      const signature = await signMessageAsync({ message });

      // Step 4: Verify (Quan trọng: Normalize address trước khi gửi)
      const verifyRes = await api.post('/auth/verify', { 
        address: address.toLowerCase(), 
        signature 
      });

      // Step 5: Lưu session
      const { accessToken, user } = verifyRes.data;
      setSession({ accessToken: accessToken || verifyRes.data.token, user });
      setAuth({ isAuthenticated: true, user });

      console.log("✅ SIWE Authenticated!");
      return verifyRes.data;

    } catch (error) {
      console.error('❌ SIWE Error:', error.response?.data || error.message);
      clearSession();
      if (disconnectAsync) await disconnectAsync();
      throw error;
    }
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    clearSession();
    setAuth({ isAuthenticated: false, user: null });
    if (disconnectAsync) await disconnectAsync();
  };

  return { login, logout, auth };
}
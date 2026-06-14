import { useCallback, useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { vaultAbi } from '../../lib/abis';

// Khi DISPUTED, contract đặt timeoutDeadline = type(uint256).max → coi như không có hạn timeout.
const MAX_UINT256 = (1n << 256n) - 1n;

function formatRemaining(totalSeconds) {
  if (totalSeconds <= 0) return '00:00:00';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  const hms = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

/**
 * Đọc deadline on-chain (timeoutDeadline khi LOCKED, disputeDeadline khi DISPUTED) và
 * đếm ngược theo thời gian thực mỗi giây.
 *
 * @param {string} vaultAddress - địa chỉ EscrowVault
 * @param {('timeout'|'dispute')} kind - loại deadline cần theo dõi
 * @param {boolean} enabled - bật/tắt việc đọc (vd: chỉ bật khi đúng trạng thái)
 * @returns {{ deadlineSec: number|null, remainingSec: number, expired: boolean, formatted: string, loading: boolean, deadlineDate: Date|null }}
 */
export function useTimeoutCountdown(vaultAddress, kind = 'timeout', enabled = true) {
  const publicClient = usePublicClient();
  const [deadlineSec, setDeadlineSec] = useState(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(false);

  const functionName = kind === 'dispute' ? 'disputeDeadline' : 'timeoutDeadline';

  const fetchDeadline = useCallback(async () => {
    if (!vaultAddress || !publicClient || !enabled) {
      setDeadlineSec(null);
      return;
    }
    setLoading(true);
    try {
      const raw = await publicClient.readContract({
        address: vaultAddress,
        abi: vaultAbi,
        functionName
      });
      const value = BigInt(raw);
      // type(uint256).max nghĩa là deadline đã bị vô hiệu hóa.
      setDeadlineSec(value >= MAX_UINT256 ? null : Number(value));
    } catch {
      setDeadlineSec(null);
    } finally {
      setLoading(false);
    }
  }, [vaultAddress, publicClient, enabled, functionName]);

  useEffect(() => {
    fetchDeadline();
  }, [fetchDeadline]);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [enabled]);

  const remainingSec = deadlineSec == null ? 0 : Math.max(0, deadlineSec - nowSec);
  const expired = deadlineSec != null && remainingSec <= 0;

  return {
    deadlineSec,
    remainingSec,
    expired,
    formatted: formatRemaining(remainingSec),
    loading,
    deadlineDate: deadlineSec != null ? new Date(deadlineSec * 1000) : null,
    refetch: fetchDeadline
  };
}

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { useAccount } from 'wagmi';

// --- IMPORT STATE & LOGIC HOOKS ---
import {
  addSystemLogAtom,
  escrowStatusAtom,
  signatureProgressAtom,
  systemLogsAtom,
  signedNodesAtom,
  signingPhaseAtom,
  signingProgressAtom,
  aggregatedSignatureAtom,
  selectedActionAtom,
  nonceRound1Atom
} from '../features/escrow/escrowStore';
import { useEscrowSync } from '../features/escrow/useEscrowSync';
import { useSessionRecovery } from '../features/escrow/useSessionRecovery';
import { useContractCall } from '../features/escrow/useContractCall';
import { useTimeoutCountdown } from '../features/escrow/useTimeoutCountdown';
import { useTssWorker } from '../features/escrow/useTssWorker'; // Tích hợp Phase 5: Web Worker
import { useDkgPhase, DKG_STATE, clearDkgLocalState } from '../features/escrow/use-dkg-phase';

// --- IMPORT API & STORAGE ---
import api from '../lib/api';
import { getPubKey, getPrivKey, savePrivKey, savePubKey, unlockEncryptedPrivKey } from '../lib/storage';
import { socket, joinEscrowRoom, leaveEscrowRoom } from '../lib/socket';

import { getStoredAccessToken } from '../store/authStore';
import { useSIWE } from '../hooks/useSIWE';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveRoleFromEscrow(escrow, walletAddress) {
  const normalizedWalletAddress = normalizeAddress(walletAddress);
  if (!normalizedWalletAddress || !escrow) return 'Unknown';

  if (normalizeAddress(escrow?.buyer?.walletAddress || escrow?.buyerAddress) === normalizedWalletAddress) return 'buyer';
  if (normalizeAddress(escrow?.seller?.walletAddress || escrow?.sellerAddress) === normalizedWalletAddress) return 'seller';

  const mediatorRow = (escrow?.escrowMediators || []).find((row) => {
    const mAddr = normalizeAddress(row?.mediator?.walletAddress || row?.mediatorAddress);
    return mAddr === normalizedWalletAddress;
  });

  if (mediatorRow?.slot) return `mediator${mediatorRow.slot}`;

  return 'Unknown';
}

function normalizeDisplayAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return '0';
  return String(amount);
}

// Helper: kiểm tra một role có nằm trong signerBitmap không.
// Bit convention (khớp backend calculateSignerBitmap): buyer=bit0, seller=bit1, mediator{n}=bit(n+1).
function roleInBitmap(role, bitmap) {
  if (bitmap === undefined || bitmap === null) return false;
  let bit;
  if (role === 'buyer') bit = 0;
  else if (role === 'seller') bit = 1;
  else if (role?.startsWith('mediator')) {
    const slot = Number(role.replace('mediator', ''));
    if (!Number.isInteger(slot) || slot < 1 || slot > 5) return false;
    bit = slot + 1;
  } else return false;
  return (Number(bitmap) & (1 << bit)) !== 0;
}

// Helper: Validate signerBitmap
// isDisputeResolution=true relaxes core-role check to AT LEAST ONE (mirrors contract logic)
function validateSignerBitmap(bitmap, action, isDisputeResolution = false) {
  const ALLOWED_BITS_MASK = 0x7f;
  const CORE_ROLE_MASK = 0x03;
  const MIN_SIGNERS = 5;
  const b = Number(bitmap);
  if (!Number.isFinite(b)) return { valid: false, error: 'Invalid bitmap' };
  if ((b & ~ALLOWED_BITS_MASK) !== 0) return { valid: false, error: 'Bitmap contains invalid bits' };

  let temp = b;
  let count = 0;
  while (temp) { temp &= temp - 1; count++; }
  if (count < MIN_SIGNERS) return { valid: false, error: `Need at least ${MIN_SIGNERS} signers, got ${count}` };

  if (action === 'release' || action === 'split') {
    if (isDisputeResolution) {
      if ((b & CORE_ROLE_MASK) === 0) {
        return { valid: false, error: `Action '${action}' requires at least one core party (buyer or seller)` };
      }
    } else {
      if ((b & CORE_ROLE_MASK) !== CORE_ROLE_MASK) {
        return { valid: false, error: `Action '${action}' requires both buyer and seller to approve` };
      }
    }
  }

  return { valid: true };
}

export default function EscrowDetail() {
  // 1. Lấy Context & Định danh
  const { id: escrowId } = useParams();
  const { address } = useAccount();

  const [escrow, setEscrow] = useState(null);
  const [isEscrowLoading, setIsEscrowLoading] = useState(true);
  const [onChainVaultStatus, setOnChainVaultStatus] = useState(null);
  const [approvalStatus, setApprovalStatus] = useState(null);
  const [finalTxHash, setFinalTxHash] = useState(null); // hash tx execute on-chain để hiện link ở banner
  const [isLoadingApprovals, setIsLoadingApprovals] = useState(false);
  const [isDkgComplete, setIsDkgComplete] = useState(null); // null=unknown, true=done, false=needed
  const [dkgCommitmentCount, setDkgCommitmentCount] = useState(0); // 0-7: số parties đã xong B1
  const addLog = useSetAtom(addSystemLogAtom);
  const setNonceRound1 = useSetAtom(nonceRound1Atom);
  const setSigningPhase = useSetAtom(signingPhaseAtom);

  // 2. Khởi tạo Logic Chạy ngầm (Cập nhật lấy thêm deployEscrowVault)
  const { isRecovering } = useSessionRecovery(escrowId, address);
  const { submitPubKey, submitNonce, submitZShare, resetSigning } = useEscrowSync(escrowId, escrow?.status);
  const { executeTssAction, fundEscrow, getVaultStatus, triggerTimeoutAction, isPending, isConfirming, isConfirmed, deployEscrowVault, waitForTx, hash: hookTxHash } = useContractCall();
  const { computeNonceFrost, computeZShare, hasNonce, executeWorkerTask, clearNonce } = useTssWorker(); // Khởi tạo Web Worker Hook

  // 3. Đọc State từ Jotai để render UI
  const status = useAtomValue(escrowStatusAtom);
  const progress = useAtomValue(signatureProgressAtom);
  const setProgress = useSetAtom(signatureProgressAtom);
  const logs = useAtomValue(systemLogsAtom);
  const setSignedNodes = useSetAtom(signedNodesAtom);
  const signingPhase = useAtomValue(signingPhaseAtom);
  const signingProgress = useAtomValue(signingProgressAtom);
  const aggregatedSignature = useAtomValue(aggregatedSignatureAtom);
  const selectedAction = useAtomValue(selectedActionAtom);
  const nonceRound1 = useAtomValue(nonceRound1Atom);
  const setSelectedAction = useSetAtom(selectedActionAtom);

  const { login } = useSIWE();
  const hasLocalToken = Boolean(getStoredAccessToken());

  // activeRole phải được khai báo trước useDkgPhase
  const activeRole = useMemo(() => {
    return resolveRoleFromEscrow(escrow, address);
  }, [escrow, address]);

  // DKG Phase hook — chỉ active khi có privKey (lazy)
  const dkgPrivKey = getPrivKey(address);
  const { state: dkgState, error: dkgError, progress: dkgProgress, dkgResult, runDkg } = useDkgPhase(
    escrowId,
    activeRole !== 'Unknown' ? activeRole : null,
    executeWorkerTask,
    dkgPrivKey,
    address
  );

  const ALLOWED_SIGNERS = ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5'];
  const isAllowedSigner = ALLOWED_SIGNERS.includes(activeRole);

  // Single source-of-truth: which TSS action to execute.
  // Happy path default is 'release'. Dispute outcome is action-aligned (incl. legacy values):
  //   RELEASE → release() funds to seller
  //   REFUND  → refund()  funds to buyer
  //   SPLIT   → split() 50/50
  const determinedAction = useMemo(() => {
    const resolvedDispute = Array.isArray(escrow?.disputes)
      ? escrow.disputes.find(d => d.status === 'RESOLVED')
      : null;
    if (!resolvedDispute) return 'release';
    const outcome = String(resolvedDispute.outcome || '').toUpperCase();
    if (outcome === 'RELEASE' || outcome === 'RETURN_TO_SELLER') return 'release';
    if (outcome === 'REFUND' || outcome === 'RELEASE_TO_BUYER') return 'refund';
    if (outcome === 'SPLIT') return 'split';
    return 'release';
  }, [escrow?.disputes]);

  // Check nonce state on mount to update UI
  useEffect(() => {
    let isMounted = true;
    const checkNonceState = async () => {
      if (escrowId && selectedAction && activeRole && activeRole !== 'Unknown') {
        const nonceKey = `${escrowId}:${selectedAction}:${activeRole}`;
        const exists = await hasNonce(nonceKey);
        if (isMounted) {
          console.log(`[EscrowDetail] Nonce state check: ${nonceKey} - ${exists ? 'EXISTS' : 'NOT EXISTS'}`);
        }
      }
    };
    checkNonceState();
    return () => { isMounted = false; };
  }, [escrowId, selectedAction, activeRole, hasNonce]);

  // Cờ kiểm tra tính độc quyền UI — khai báo sớm để dùng trong useEffect bên dưới
  const hasVaultAddress = Boolean(escrow?.contractAddress || escrow?.vaultAddress);

  // Kiểm tra DKG master-pubkey có trên backend chưa (on mount + khi escrowId thay đổi)
  useEffect(() => {
    if (!escrowId || hasVaultAddress) return;
    let active = true;
    api.get(`/escrow/${escrowId}/dkg/master-pubkey`)
      .then(() => { if (active) setIsDkgComplete(true); })
      .catch(() => { if (active) setIsDkgComplete(false); });
    return () => { active = false; };
  }, [escrowId, hasVaultAddress]);

  // Sau khi party này hoàn thành DKG, poll cho đến khi backend xác nhận tất cả parties xong
  useEffect(() => {
    if (dkgState !== DKG_STATE.COMPLETE || !escrowId || isDkgComplete) return;
    let active = true;
    const check = async () => {
      try {
        await api.get(`/escrow/${escrowId}/dkg/master-pubkey`);
        if (active) { setIsDkgComplete(true); setDkgCommitmentCount(7); }
      } catch { /* keep polling */ }
    };
    const interval = setInterval(check, 5000);
    check();
    return () => { active = false; clearInterval(interval); };
  }, [dkgState, escrowId, isDkgComplete]);

  const localPubKey = getPubKey(address);
  const isVaultLockedOnChain = onChainVaultStatus !== null && Number(onChainVaultStatus) >= 1;
  const isVaultTerminalOnChain = onChainVaultStatus !== null && [2, 3].includes(Number(onChainVaultStatus));
  const isEscrowTerminal = ['RELEASED', 'REFUNDED', 'COMPLETED'].includes(String(escrow?.status || '').toUpperCase());
  const isSigningFlowClosed = isVaultTerminalOnChain || isEscrowTerminal;

  // ─── Luồng quá hạn (timeout) ────────────────────────────────────────────────
  const vaultAddress = escrow?.contractAddress || escrow?.vaultAddress || null;
  const escrowStatusUpper = String(escrow?.status || '').toUpperCase();
  const isLockedStatus = escrowStatusUpper === 'LOCKED' || (isVaultLockedOnChain && !isVaultTerminalOnChain && escrowStatusUpper !== 'DISPUTED');
  const isDisputedStatus = escrowStatusUpper === 'DISPUTED' || Number(onChainVaultStatus) === 4;
  const isParticipant = activeRole && activeRole !== 'Unknown';
  const [isTriggeringTimeout, setIsTriggeringTimeout] = useState(false);

  // Đếm ngược tới timeoutDeadline khi LOCKED, hoặc disputeDeadline khi DISPUTED.
  const timeoutCountdown = useTimeoutCountdown(vaultAddress, 'timeout', Boolean(vaultAddress) && isLockedStatus);
  const disputeCountdown = useTimeoutCountdown(vaultAddress, 'dispute', Boolean(vaultAddress) && isDisputedStatus);

  const handleTriggerTimeout = useCallback(async () => {
    if (!vaultAddress) return;
    setIsTriggeringTimeout(true);
    try {
      const txHash = await triggerTimeoutAction(vaultAddress);
      addLog({ message: 'Đã gửi giao dịch kích hoạt quá hạn. Đang chờ xác nhận...', type: 'info' });
      if (txHash) await waitForTx(txHash);
      addLog({ message: 'Quá hạn đã được kích hoạt — escrow chuyển sang DISPUTED.', type: 'success' });
      // Đồng bộ lại trạng thái escrow + on-chain.
      try {
        const { data: fresh } = await api.get(`/escrows/${escrowId}`);
        setEscrow(fresh);
        const addr = fresh?.contractAddress || fresh?.vaultAddress || vaultAddress;
        if (addr) setOnChainVaultStatus(Number(await getVaultStatus(addr)));
      } catch { /* refresh lỗi không chặn flow */ }
    } catch (error) {
      addLog({ message: `Kích hoạt quá hạn thất bại: ${error.message}`, type: 'error' });
    } finally {
      setIsTriggeringTimeout(false);
    }
  }, [vaultAddress, triggerTimeoutAction, waitForTx, escrowId, getVaultStatus, addLog]);

  // Auto-scroll Terminal
  const logsEndRef = useRef(null);

  // Fallback Polling: Nếu kẹt ở DRAFT nhưng đã có Vault Address, tự động quét Backend mỗi 5s
  useEffect(() => {
    if (!escrowId) return;
    let interval = null;
    let attempts = 0;
    const maxAttempts = 12; // Thử tối đa 1 phút

    const shouldPoll = () => {
      const currentStatus = String(escrow?.status || '').toUpperCase();
      return currentStatus === 'DRAFT' && Boolean(escrow?.contractAddress || escrow?.vaultAddress);
    };

    if (shouldPoll()) {
      interval = setInterval(async () => {
        attempts += 1;
        try {
          const { data: fresh } = await api.get(`/escrows/${escrowId}`);
          setEscrow(fresh);
          // Nếu status đã thoát khỏi DRAFT, dừng quét
          if (String(fresh?.status || '').toUpperCase() !== 'DRAFT') {
            clearInterval(interval);
          }
        } catch (err) {
          console.warn('[EscrowDetail] Poll fetch failed:', err?.message || err);
        }
        if (attempts >= maxAttempts) clearInterval(interval);
      }, 5000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [escrowId, escrow?.status, escrow?.contractAddress, escrow?.vaultAddress]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // 4. Lấy thông tin Escrow thật từ backend
  useEffect(() => {
    let active = true;

    const fetchEscrowDetail = async () => {
      if (!escrowId) return;
      setIsEscrowLoading(true);
      try {
        const { data } = await api.get(`/escrows/${escrowId}`);
        if (!active) return;
        setEscrow(data);
        if (data?.pkAggBsX && data?.pkAggBsY) {
          setProgress(7);
          setDkgCommitmentCount(7);
          setIsDkgComplete(true);
          setSignedNodes(['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5']);
        }
      } catch {
        // ignore fetch error
      } finally {
        if (active) setIsEscrowLoading(false);
      }
    };

    fetchEscrowDetail();
    return () => { active = false; };
  }, [escrowId, setProgress, setSignedNodes]);

  useEffect(() => {
    let active = true;

    const checkOnChainStatus = async () => {
      const vaultAddress = escrow?.contractAddress || escrow?.vaultAddress;
      if (!vaultAddress) {
        if (active) setOnChainVaultStatus(null);
        return;
      }

      try {
        const statusValue = await getVaultStatus(vaultAddress);
        if (!active) return;
        setOnChainVaultStatus(Number(statusValue));
      } catch {
        if (!active) return;
      }
    };

    checkOnChainStatus();
    return () => {
      active = false;
    };
  }, [escrow?.contractAddress, escrow?.vaultAddress]);

  // --- DKG COMPLETION: lưu signing private key cục bộ ---
  // B4 hoàn tất: lưu signing share cục bộ.
  // Backend derive signing pubkeys từ Feldman commitments (không cần submit riêng).
  useEffect(() => {
    if (dkgState !== DKG_STATE.COMPLETE || !dkgResult || !activeRole || activeRole === 'Unknown' || !address) return;

    const { finalShareHex, signingPubKey } = dkgResult;
    const pubKeyHex = `0x04${signingPubKey.x.padStart(64, '0')}${signingPubKey.y.padStart(64, '0')}`;

    savePrivKey(finalShareHex, address);
    savePubKey(pubKeyHex, address);
    addLog({ message: '[DKG] ✅ Signing private key đã lưu cục bộ. Sẵn sàng ký.', type: 'success' });
  }, [dkgState, dkgResult, activeRole, address, addLog]);

  // --- KHÔI PHỤC STATE ROUND 2 KHI RE-LOGIN / RELOAD ---
  // Nếu backend báo Round 1 đã chốt (round2_ready), hiển thị ngay nút Z-Share với challenge
  // đã khoá — không bắt party chạy lại Round 1 (gây đổi challenge → InvalidSignature).
  useEffect(() => {
    if (!escrowId || !activeRole || activeRole === 'Unknown') return;
    let active = true;
    api.get(`/escrow/${escrowId}/status`)
      .then(({ data }) => {
        if (!active) return;
        // Khởi tạo DKG gate ngay khi load: không phụ thuộc vào dkgState của session hiện tại
        if (typeof data?.dkgCommitmentCount === 'number') {
          setDkgCommitmentCount(data.dkgCommitmentCount);
          if (data.dkgCommitmentCount >= 7) setIsDkgComplete(true);
        }
        // Restore pubkey collection state: nếu tất cả 7 signing pubkeys đã submit
        // (có thể từ session trước), set progress = 7 để unlock signing button ngay.
        if (data?.pubkeyCollection?.received >= 7) {
          setProgress(7);
          setSignedNodes(['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5']);
        }
        if (data?.signingState === 'round2_ready' && data?.round2Context) {
          if (data.signingAction) setSelectedAction(data.signingAction);
          setNonceRound1(data.round2Context);
          setSigningPhase('z-share');
          addLog({ message: 'Khôi phục phiên ký: Round 1 đã hoàn tất, sẵn sàng Round 2 (Z-Share).', type: 'info' });
        }
      })
      .catch(() => { /* no active signing session — ignore */ });
    return () => { active = false; };
  }, [escrowId, activeRole, setNonceRound1, setSigningPhase, setSelectedAction, addLog]);

  // --- DEBOUNCE REFRESH: Gom nhóm các API request bị spam ---
  const refreshTimeoutRef = useRef(null);
  const scheduleEscrowRefresh = useCallback(() => {
    if (!escrowId) return;
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    refreshTimeoutRef.current = setTimeout(async () => {
      try {
        const { data: fresh } = await api.get(`/escrows/${escrowId}`);
        setEscrow(fresh);
      } catch (err) {
        console.warn('[EscrowDetail] Delayed refresh failed', err?.message || err);
      } finally {
        refreshTimeoutRef.current = null;
      }
    }, 600);
  }, [escrowId]);

  // Lắng nghe sự kiện WebSocket (sử dụng debounce refresh)
  useEffect(() => {
    if (!escrowId) return;

    const handleVaultDeployed = (data) => {
      if (data?.escrowId !== escrowId) return;
      scheduleEscrowRefresh();
    };

    const handleMediatorsSelected = (data) => {
      if (data?.escrowId !== escrowId) return;
      scheduleEscrowRefresh();
    };

    socket.on('vault_deployed', handleVaultDeployed);
    socket.on('mediators_selected', handleMediatorsSelected);

    return () => {
      socket.off('vault_deployed', handleVaultDeployed);
      socket.off('mediators_selected', handleMediatorsSelected);
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    };
  }, [escrowId, scheduleEscrowRefresh]);

  // Ép buộc kết nối phòng Socket thông qua Guard mới (Tránh duplicate stream)
  useEffect(() => {
    if (!escrowId) return;
    const token = getStoredAccessToken();
    if (!token) return;

    joinEscrowRoom(escrowId, token).then((response) => {
      if (response?.ok) {
        addLog({ message: `Joined secure room for Escrow #${escrowId} (explicit join)`, type: 'success' });
      } else {
        addLog({ message: `Explicit join room failed: ${response?.error || 'unknown error'}`, type: 'warning' });
      }
    });

    return () => {
      leaveEscrowRoom(escrowId);
    };
  }, [escrowId, addLog]);

  // --- RESET DKG (cho phép chạy lại DKG khi vault key không khớp signing keys) ---
  const [isResettingDkg, setIsResettingDkg] = useState(false);

  const handleResetDkg = useCallback(async () => {
    if (!escrowId || !address) return;
    if (!window.confirm('Reset toàn bộ DKG? Tất cả 7 parties phải chạy lại DKG từ đầu. Vault đã deploy sẽ không còn dùng được nữa nếu master key thay đổi!')) return;
    setIsResettingDkg(true);
    try {
      await api.post(`/escrow/${escrowId}/dkg/reset`);
      clearDkgLocalState(escrowId, address);
      addLog({ message: 'DKG đã được reset. Tất cả parties cần chạy lại DKG.', type: 'warning' });
    } catch (e) {
      addLog({ message: `Reset DKG thất bại: ${e.message}`, type: 'error' });
    } finally {
      setIsResettingDkg(false);
    }
  }, [escrowId, address, addLog]);

  // --- KHỐI XỬ LÝ DEPLOY TỪ VÍ BUYER ---
  const [isDeploying, setIsDeploying] = useState(false);

  const handleDeploy = useCallback(async () => {
    if (!escrowId || !escrow) return;
    if (activeRole !== 'buyer') {
      addLog({ message: 'Chỉ Buyer mới có quyền Deploy Vault.', type: 'warning' });
      return;
    }

    setIsDeploying(true);
    try {
      addLog({ message: 'Đang xác thực DKG và lấy dữ liệu Deploy...', type: 'info' });

      // 1) Đảm bảo đủ 5 Trọng tài đã được VRF chọn
      const { data: escrowFresh } = await api.get(`/escrows/${escrowId}`);
      const mediatorsRows = escrowFresh.escrowMediators || [];
      if (!Array.isArray(mediatorsRows) || mediatorsRows.length !== 5) {
        throw new Error('Cannot deploy: Mediator assignment incomplete. Wait for VRF.');
      }
      const mediatorAddrs = mediatorsRows.map((r) => normalizeAddress(r.mediator?.walletAddress || r.mediatorAddress));

      // 2) Lấy master public key từ Pedersen VSS DKG (P = Σ Cᵢ₀)
      const { data: dkgKey } = await api.get(`/escrow/${escrowId}/dkg/master-pubkey`);
      if (!dkgKey?.masterPubKey) {
        throw new Error(`DKG incomplete: ${dkgKey?.error || 'master public key not available'}. Chờ tất cả 7 parties hoàn thành DKG.`);
      }

      const x = BigInt(dkgKey.masterPubKey.x);
      const y = BigInt(dkgKey.masterPubKey.y);
      if (x === 0n || y === 0n) throw new Error('Master public key invalid (zero).');

      const factoryAddress = import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS;
      addLog({ message: 'Vui lòng xác nhận giao dịch Deploy trên MetaMask...', type: 'info' });

      let deploymentResult;
      try {
        deploymentResult = await deployEscrowVault(
          factoryAddress,
          normalizeAddress(escrowFresh.seller?.walletAddress || escrowFresh.sellerAddress),
          mediatorAddrs,
          [x, y],
          escrowFresh.amount
        );
      } catch (innerErr) {
        console.warn('deployEscrowVault ném lỗi nội bộ nhưng có thể giao dịch đã gửi:', innerErr);
      }

      let txHash = null;
      if (typeof deploymentResult === 'string') {
        txHash = deploymentResult;
      } else if (deploymentResult && typeof deploymentResult === 'object') {
        if (typeof deploymentResult.hash === 'string') txHash = deploymentResult.hash;
        else if (typeof deploymentResult.transactionHash === 'string') txHash = deploymentResult.transactionHash;
      }

      if (!txHash && hookTxHash) txHash = hookTxHash;

      if (!txHash) {
        for (let i = 0; i < 8 && !txHash; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (hookTxHash) txHash = hookTxHash;
        }
      }

      if (!txHash) {
        addLog({ message: 'Giao dịch đã gửi nhưng chưa lấy được hash. Vui lòng chờ Socket cập nhật.', type: 'warning' });
      } else {
        addLog({ message: `Đã gửi TX: ${txHash}. Đang chờ Blockchain xác nhận (15-30s)...`, type: 'info' });

        const receipt = await waitForTx(txHash);

        // viem returns receipt.status as 'success' | 'reverted' (string), not 1/0.
        // Treat both the string and any legacy numeric form as a revert.
        if (receipt && (receipt.status === 'reverted' || receipt.status === 0)) {
          throw new Error('Transaction reverted on-chain. Deploy did not succeed (check gas limit / contract requirements).');
        }

        addLog({ message: `✅ Block mined (Block #${receipt.blockNumber}). Syncing with database...`, type: 'success' });

        await api.post('/escrow/record-deploy', { escrowId, txHash });

        addLog({ message: 'Deploy recorded successfully. Updating UI...', type: 'success' });

        const token = getStoredAccessToken();
        if (token) {
          joinEscrowRoom(escrowId, token).then((response) => {
            if (response?.ok) addLog({ message: 'Socket room joined after deploy.', type: 'info' });
          });
        }

        try {
          const { data: fresh } = await api.get(`/escrows/${escrowId}`);
          setEscrow(fresh);
        } catch {
          console.warn('Could not refresh escrow immediately after deploy.');
        }
      }
    } catch (err) {
      console.error('[handleDeploy] Lỗi tàn khốc:', err);
      const msg = err?.response?.data?.error || err?.message || String(err);
      // Nếu DB đã có contractAddress (deploy trước đó thành công nhưng UI chưa refresh),
      // tự động refresh state để UI hiển thị đúng thay vì kẹt ở Bước 1
      if (err?.response?.status === 409) {
        addLog({ message: 'Hợp đồng đã được deploy trước đó. Đang cập nhật UI...', type: 'warning' });
        try {
          const { data: fresh } = await api.get(`/escrows/${escrowId}`);
          setEscrow(fresh);
        } catch {
          addLog({ message: `Lỗi Deploy: ${msg}`, type: 'error' });
        }
      } else {
        addLog({ message: `Lỗi Deploy: ${msg}`, type: 'error' });
      }
    } finally {
      setIsDeploying(false);
    }
  }, [escrowId, escrow, activeRole, deployEscrowVault, addLog, hookTxHash]);

  // --- BẢN VÁ PHASE 2: LUỒNG NẠP TIỀN CHO BUYER  ---
  const handleDepositFunds = useCallback(async () => {
    try {
      const vaultAddress = escrow?.contractAddress || escrow?.vaultAddress;
      if (!vaultAddress) {
        addLog({ message: "CRITICAL: Escrow chưa được gán địa chỉ Smart Contract. Vui lòng F5.", type: 'error' });
        return;
      }

      addLog({ message: `Đang yêu cầu MetaMask khóa ${normalizeDisplayAmount(escrow?.amount)} ETH on-chain...`, type: 'warning' });

      let depositResult;
      try {
        depositResult = await fundEscrow(vaultAddress, escrow?.amount);
      } catch (onchainErr) {
        console.warn('fundEscrow threw:', onchainErr);
      }

      let txHash = null;
      if (typeof depositResult === 'string') txHash = depositResult;
      else if (depositResult && typeof depositResult === 'object') {
        if (typeof depositResult.hash === 'string') txHash = depositResult.hash;
        else if (typeof depositResult.transactionHash === 'string') txHash = depositResult.transactionHash;
      }
      if (!txHash && hookTxHash) txHash = hookTxHash;

      // 1. ÉP DB CHUYỂN SANG LOCKED NGAY LẬP TỨC (Sửa lỗi kẹt INITIALIZED)
      try {
        await api.patch(`/escrows/${escrowId}/status`, { status: 'LOCKED' });
        addLog({ message: 'Local UI: Đã ép DB cập nhật trạng thái thành LOCKED.', type: 'success' });
      } catch (err) {
        if (err?.response?.status === 409) {
          addLog({ message: 'Worker đã cập nhật DB thành LOCKED trước; đang đồng bộ UI...', type: 'info' });
        } else {
          console.warn('Patch status failed:', err);
        }
      }

      // 2. KÉO DỮ LIỆU MỚI VỀ ĐỂ ÉP REACT RENDER LẠI (Không cần F5)
      try {
        const { data: fresh } = await api.get(`/escrows/${escrowId}`);
        setEscrow(fresh);

        try {
          const onChain = await getVaultStatus(fresh.contractAddress || fresh.vaultAddress);
          setOnChainVaultStatus(Number(onChain));
        } catch (inner) {
          console.warn('Cannot read on-chain status after deposit:', inner);
        }
        addLog({ message: 'Nạp tiền ghi nhận & UI đã được làm mới!', type: 'success' });
      } catch {
        addLog({ message: 'Nạp tiền thành công nhưng UI refresh lỗi. Vui lòng chờ Socket.', type: 'warning' });
      }
    } catch (error) {
      console.error('[handleDepositFunds] Lỗi tàn khốc:', error);
      addLog({ message: `Deposit action failed: ${error.message || String(error)}`, type: 'error' });
    }
  }, [escrowId, escrow, fundEscrow, getVaultStatus, hookTxHash, addLog]);

  // --- BẢN VÁ TSS CHUẨN MỰC: TÔN TRỌNG ĐỐI TƯỢNG BIGNUMBER ---
  const extractTrueHex = (val) => {
    if (!val) return null;
    let hex = '';

    // Nếu nó là đối tượng BigNumber (BN.js hoặc Ethers.js)
    if (typeof val === 'object') {
      if (typeof val.toHexString === 'function') {
        hex = val.toHexString(); // ethers.js
      } else if (typeof val.toString === 'function') {
        hex = val.toString(16);  // BN.js: BẮT BUỘC TRUYỀN SỐ 16 ĐỂ LẤY HEX
      }
    }
    // Nếu nó là BigInt của JS
    else if (typeof val === 'bigint' || typeof val === 'number') {
      hex = val.toString(16);
    }
    // Nếu nó đã là chuỗi
    else if (typeof val === 'string') {
      hex = val;
    }

    // Làm sạch và đệm đủ 64 ký tự chuẩn 32-bytes
    hex = hex.replace(/^0x/i, '').toLowerCase();
    return '0x' + hex.padStart(64, '0');
  };

  const buildNonceKey = useCallback((action) => {
    if (!escrowId || !action || !activeRole || activeRole === 'Unknown') return null;
    return `${escrowId}:${action}:${activeRole}`;
  }, [escrowId, activeRole]);

  // Fetch approval status from backend
  const fetchApprovalStatus = useCallback(async (action) => {
    if (!escrowId || !action) return;
    setIsLoadingApprovals(true);
    try {
      const { data } = await api.get(`/escrow/${escrowId}/approvals?action=${action}`);
      setApprovalStatus(data);

      if (!data.isValid) {
        addLog({ message: `⚠️ Approval validation: ${data.validationError}`, type: 'warning' });
      } else {
        addLog({ message: `✅ Approval status: ${data.approvedRoles.length} signers approved`, type: 'info' });
      }
    } catch (error) {
      console.error('Failed to fetch approval status:', error);
      addLog({ message: '⚠️ Failed to fetch approval status', type: 'warning' });
    } finally {
      setIsLoadingApprovals(false);
    }
  }, [escrowId]);

  // Fetch approval status khi đổi action HOẶC khi có nonce/z-share mới (signingProgress đổi).
  // Đảm bảo chip signer hiển thị khớp bitmap thật theo thời gian thực trong Round 1/2.
  useEffect(() => {
    if (selectedAction) {
      fetchApprovalStatus(selectedAction);
    }
  }, [selectedAction, fetchApprovalStatus, signingProgress?.submitted, signingProgress?.round]);

  const handleStartSigning = async (action) => {
    if (isSigningFlowClosed) {
      addLog({ message: 'Signing flow is closed because this vault is already finalized.', type: 'warning' });
      return;
    }
    if (dkgCommitmentCount < 7) {
      addLog({ message: `⚠️ Cannot sign: chỉ có ${dkgCommitmentCount}/7 parties hoàn thành DKG. Chờ tất cả parties chạy xong Pedersen VSS DKG.`, type: 'warning' });
      return;
    }

    // If a stale session exists for a DIFFERENT action (e.g., 'release' started before dispute
    // resolved to 'refund'), reset it first so the new action gets a clean Round 1.
    if (selectedAction && selectedAction !== action) {
      addLog({ message: `Resetting stale signing session (${selectedAction} → ${action})...`, type: 'warning' });
      try {
        await resetSigning(selectedAction, 'action_mismatch_dispute_outcome');
        const staleNonceKey = `${escrowId}:${selectedAction}:${activeRole}`;
        await clearNonce(staleNonceKey);
      } catch (e) {
        console.warn('[handleStartSigning] Reset stale session failed:', e?.message);
      }
    }

    setSelectedAction(action);

    try {
      const nonceKey = buildNonceKey(action);
      if (!nonceKey) throw new Error('Cannot start Round 1: unresolved escrow/action/role context');

      // FROST: sinh dual nonce k1, k2 → R1, R2
      const frostResult = await computeNonceFrost(nonceKey);
      const safe_R_x = extractTrueHex(frostResult.R1_x);
      const safe_R_y = extractTrueHex(frostResult.R1_y);
      const safe_R2_x = extractTrueHex(frostResult.R2_x);
      const safe_R2_y = extractTrueHex(frostResult.R2_y);

      addLog({ message: `Submitting FROST dual nonce for action: ${action}...`, type: 'info' });
      let nonceResponse;
      try {
        nonceResponse = await submitNonce(escrowId, activeRole, action, 0, safe_R_x, safe_R_y, safe_R2_x, safe_R2_y);
      } catch (nonceError) {
        // Backend has a different action in progress (another party started a different action).
        // Auto-reset and retry once with the correct action.
        if (nonceError.response?.status === 409 && nonceError.response?.data?.error?.includes('Different action')) {
          addLog({ message: `Backend session mismatch — resetting and retrying with action '${action}'...`, type: 'warning' });
          await resetSigning(action, 'action_mismatch_retry');
          const staleKey = `${escrowId}:${action}:${activeRole}`;
          await clearNonce(staleKey);
          // Re-compute fresh nonce after reset
          const freshFrost = await computeNonceFrost(nonceKey);
          nonceResponse = await submitNonce(
            escrowId, activeRole, action, 0,
            extractTrueHex(freshFrost.R1_x), extractTrueHex(freshFrost.R1_y),
            extractTrueHex(freshFrost.R2_x), extractTrueHex(freshFrost.R2_y)
          );
        } else {
          throw nonceError;
        }
      }

      const actualSignerBitmap = nonceResponse.signerBitmap;
      addLog({ message: `Backend confirmed signerBitmap: ${actualSignerBitmap}`, type: 'info' });

      // Round 1 đã chốt → vào thẳng Round 2 với challenge đã khoá.
      if (nonceResponse.state === 'round2_ready' && nonceResponse.round2Context) {
        setNonceRound1(nonceResponse.round2Context);
        setSigningPhase('z-share');
        addLog({ message: `Round 1 đã hoàn tất. Chuyển sang Round 2 (Z-Share).`, type: 'success' });
        return;
      }

      addLog({ message: `Round 1 đang tiến hành. Chờ đủ 5 nonce...`, type: 'info' });
    } catch (error) {
      const status = error.response?.status;
      const exactError = error.response?.data?.error || error.message;
      if (status === 409) {
        addLog({ message: `⚠️ ${exactError}`, type: 'warning' });
      } else {
        addLog({ message: `[Lỗi Backend]: ${exactError}`, type: 'error' });
      }
    }
  };

  const handleRaiseDispute = async () => {
    try {
      const reasonInput = window.prompt("Please enter the reason for the dispute:", "Product does not match description");
      if (reasonInput === null) return;
      const reason = reasonInput.trim() || "No specific reason provided";
      const urlSegments = window.location.pathname.split('/');
      const safeEscrowId = urlSegments[urlSegments.length - 1];

      if (!safeEscrowId) {
        addLog({ message: 'Lỗi hệ thống: Không thể xác định Escrow ID từ URL.', type: 'error' });
        return;
      }

      const payload = { escrowId: safeEscrowId, reason: reason };
      console.log('[handleRaiseDispute] Gửi payload an toàn:', JSON.stringify(payload));
      addLog({ message: 'Initiating Dispute record in database...', type: 'info' });

      const endpoint = `/disputes?escrowId=${safeEscrowId}&reason=${encodeURIComponent(reason)}`;
      const response = await api.post(endpoint, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const disputeId = response.data?.id || response.data?.disputeId;

      addLog({ message: '✅ Dispute raised successfully. Mediators are inherited.', type: 'success' });

      // Update escrow status to DISPUTED so UI reflects the correct phase
      try {
        await api.patch(`/escrows/${safeEscrowId}/status`, { status: 'DISPUTED' });
        setEscrow(prev => prev ? { ...prev, status: 'DISPUTED' } : prev);
      } catch (patchErr) {
        console.warn('[handleRaiseDispute] Could not update escrow status:', patchErr?.message);
      }

      setTimeout(() => {
        window.location.href = `/disputes/${disputeId || safeEscrowId}`;
      }, 1500);

    } catch (error) {
      console.error('[handleRaiseDispute] Error:', error);
      const errorMsg = error.response?.data?.error || error.message;
      addLog({ message: `Dispute Initialization Error: ${errorMsg}`, type: 'error' });
    }
  };

  const handleSubmitZShare = async () => {
    try {
      if (isSigningFlowClosed) {
        throw new Error('Signing flow is closed because this vault is already finalized');
      }
      // Step 1: Lấy Round 1 response từ Backend (đã lưu trong atom)
      if (!nonceRound1?.challenge) {
        throw new Error('❌ Missing Round 1 challenge from backend - please run Round 1 first');
      }

      // Get signerBitmap from Round 1 response (from backend)
      const signerBitmap = nonceRound1.signerBitmap;
      if (signerBitmap === undefined) {
        throw new Error('❌ Missing signerBitmap from Round 1 response');
      }

      // Validate signerBitmap before submitting
      const hasResolvedDispute = Array.isArray(escrow?.disputes) && escrow.disputes.some(d => d.status === 'RESOLVED');
      const validation = validateSignerBitmap(signerBitmap, selectedAction, hasResolvedDispute);
      if (!validation.valid) {
        throw new Error(`❌ Invalid signerBitmap: ${validation.error}`);
      }

      // Step 2: Lấy private share từ session storage hoặc unlock từ bản mã hóa
      let privateKeyHex = getPrivKey(address);
      if (!privateKeyHex) {
        const passphrase = window.prompt('Enter the passphrase to unlock your encrypted private share');
        if (passphrase) {
          privateKeyHex = await unlockEncryptedPrivKey(address, passphrase.trim());
        }
      }

      if (!privateKeyHex) {
        throw new Error('❌ Missing private share in this browser session - import and unlock it first');
      }

      // Step 3: Truyền REAL crypto data vào Worker (không còn fallback values)
      const challengeHex = nonceRound1.challenge;
      const nonceKey = buildNonceKey(selectedAction);
      if (!nonceKey) throw new Error('Cannot start Round 2: action/role context is missing');

      // FROST: lấy binding factor của role mình từ round2Context (nếu có)
      const bindingFactorHex = nonceRound1.bindingFactors?.[activeRole] || null;

      const { z } = await computeZShare(privateKeyHex, challengeHex, nonceKey, bindingFactorHex);

      // KHÔNG clearPrivKey ở đây: để bấm lại Z-Share không phải nhập lại passphrase (idempotent).

      addLog({ message: `✅ Round 2 Z-Share computed successfully with real challenge: ${challengeHex}`, type: 'info' });
      addLog({ message: `📝 Submitting Z-Share with signerBitmap: ${signerBitmap}`, type: 'info' });

      // Gửi kèm challenge để backend từ chối nếu z tính trên Round 1 cũ (chống trộn challenge).
      await submitZShare(escrowId, activeRole, signerBitmap, z, challengeHex);
    } catch (error) {
      const errorMessage = String(error?.message || 'Unknown error');
      const helpMessage = errorMessage.includes('Round 1 nonce not found')
        ? 'Failed to submit Z-Share: Worker lost nonce state. Run Round 1 again, then retry Round 2.'
        : `Failed to submit Z-Share: ${errorMessage}`;
      addLog({ message: helpMessage, type: 'error' });
    }
  };

  // Hàm gọi Smart Contract sau khi có bộ chữ ký tổng hợp
  const handleExecuteOnChain = async () => {
    try {
      if (isSigningFlowClosed) {
        throw new Error('Execution is blocked because this vault is already finalized');
      }
      if (!aggregatedSignature) throw new Error("Missing aggregated signature");

      // Lấy địa chỉ từ state escrow của trang web làm phương án dự phòng
      const backupAddress = escrow?.contractAddress || escrow?.vaultAddress;

      // Truyền thêm backupAddress vào hàm gọi
      const txHash = await executeTssAction(selectedAction, aggregatedSignature, backupAddress);
      if (txHash) setFinalTxHash(txHash);

      // Refresh trạng thái escrow + vault on-chain để UI nhận biết đã finalized (ẩn signing, hiện banner)
      try {
        const { data: fresh } = await api.get(`/escrows/${escrowId}`);
        setEscrow(fresh);
        const vaultAddr = fresh?.contractAddress || fresh?.vaultAddress || backupAddress;
        if (vaultAddr) {
          const statusValue = await getVaultStatus(vaultAddr);
          setOnChainVaultStatus(Number(statusValue));
        }
      } catch (refreshErr) {
        console.warn('[Execute] Post-execute refresh failed:', refreshErr?.message || refreshErr);
      }
    } catch (error) {
      addLog({ message: `On-chain execution failed: ${error.message}`, type: 'error' });

      // If signature verification failed, reset signing session
      if (error.message?.includes('InvalidSignature') || error.message?.includes('signature')) {
        addLog({ message: `⚠️ InvalidSignature detected. Resetting signing session...`, type: 'error' });
        try {
          await resetSigning(selectedAction, 'InvalidSignature on-chain');
        } catch (resetError) {
          addLog({ message: `Failed to reset signing: ${resetError.message}`, type: 'error' });
        }
      }
    }
  };

  // --- RENDER LUỒNG RECOVERY ---
  if (isRecovering || isEscrowLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="animate-pulse text-xl text-slate-300">Loading Escrow Session...</p>
        </div>
      </div>
    );
  }

  const mediationAssigned = ['LOCKED', 'FUNDED', 'DISPUTED', 'VOTING', 'RESOLVED'].includes(
    String(escrow?.status || '').toUpperCase()
  );

  // --- RENDER GIAO DIỆN CHÍNH ---
  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans pb-20">

      {/* NAVBAR */}
      <nav className="h-20 bg-slate-800 flex items-center justify-between px-8 shadow-md border-b border-slate-700">
        <h1 className="text-2xl font-bold bg-linear-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
          TSS Escrow
        </h1>
        <div className="flex items-center gap-4">
          <span className="text-slate-400 text-sm">Role: <span className="text-white font-semibold capitalize">{activeRole}</span></span>
          <button className="px-4 py-2 bg-slate-700 hover:bg-slate-600 transition-colors rounded-lg font-mono text-sm shadow-inner cursor-default border border-slate-600">
            {address || 'Wallet not connected'}
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto mt-10 flex flex-col gap-8 px-6">
        {/* BẢNG YÊU CẦU ĐĂNG NHẬP (PHẦN 3) */}
        {!hasLocalToken && (
          <div className="bg-yellow-900/50 border border-yellow-600 p-6 rounded-xl shadow-lg mb-2">
            <h3 className="text-yellow-400 font-bold text-xl mb-2">⚠️ Yêu Cầu Đăng Nhập (SIWE)</h3>
            <p className="text-yellow-200 mb-4">Phiên đăng nhập đã hết hạn. Bạn cần ký tên bằng ví MetaMask để tải dữ liệu và cấp quyền thao tác.</p>
            <button onClick={login} className="px-6 py-3 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded-lg transition-colors">
              Sign In with Ethereum
            </button>
          </div>
        )}

        {!localPubKey && address && (
          <div className="bg-red-900/50 border-2 border-red-500 p-6 rounded-xl shadow-[0_0_20px_rgba(239,68,68,0.3)] flex flex-col items-center gap-3">
            <h3 className="text-red-400 font-bold text-xl uppercase tracking-widest">⚠️ Missing Local Keypair</h3>
            <p className="text-red-200 text-center">
              This browser profile has not initialized a Private/Public Keypair. You cannot participate in the TSS network.
            </p>
            <a href="/generate-key" className="mt-2 px-8 py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-lg transition-colors">
              Go to Key Generator
            </a>
          </div>
        )}

        {/* APPROVAL STATUS PANEL - Shows when action is selected */}
        {selectedAction && (
          <section className="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
            <div className="flex justify-between items-center border-b border-slate-700 pb-3 mb-4">
              <h3 className="text-lg font-bold text-slate-200">
                Approval Status: <span className="text-blue-400 uppercase">{selectedAction}</span>
              </h3>
              {isLoadingApprovals && (
                <span className="text-sm text-slate-400">Loading...</span>
              )}
            </div>

            {approvalStatus ? (
              <div className="space-y-3">
                {/* Validation Status */}
                <div className={`p-3 rounded-lg border ${approvalStatus.isValid ? 'bg-green-900/30 border-green-600' : 'bg-red-900/30 border-red-600'}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-lg ${approvalStatus.isValid ? 'text-green-400' : 'text-red-400'}`}>
                      {approvalStatus.isValid ? '✅' : '❌'}
                    </span>
                    <span className={approvalStatus.isValid ? 'text-green-300' : 'text-red-300'}>
                      {approvalStatus.isValid
                        ? 'Valid: Ready to execute'
                        : `Invalid: ${approvalStatus.validationError || 'Unknown error'}`}
                    </span>
                  </div>
                </div>

                {/* Signer Bitmap Info */}
                <div className="bg-slate-900/50 p-3 rounded border border-slate-700">
                  <p className="text-slate-400 text-sm">Signer Bitmap</p>
                  <p className="text-white font-mono text-lg">{approvalStatus.expectedSignerBitmap}
                    <span className="text-slate-500 text-sm ml-2">(Binary: {approvalStatus.expectedSignerBitmap.toString(2).padStart(7, '0')})</span>
                  </p>
                </div>

                {/* Approved Roles */}
                <div className="bg-slate-900/50 p-3 rounded border border-slate-700">
                  <p className="text-slate-400 text-sm mb-2">Approved Signers ({approvalStatus.approvedRoles.length}/7)</p>
                  <div className="flex flex-wrap gap-2">
                    {['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5'].map((role) => {
                      const isApproved = approvalStatus.approvedRoles.includes(role);
                      const isCore = role === 'buyer' || role === 'seller';
                      return (
                        <span
                          key={role}
                          className={`px-3 py-1 rounded-full text-sm font-medium border ${isApproved
                              ? isCore
                                ? 'bg-purple-600/30 border-purple-500 text-purple-300'
                                : 'bg-blue-600/30 border-blue-500 text-blue-300'
                              : 'bg-slate-700/50 border-slate-600 text-slate-500'
                            }`}
                        >
                          {role} {isApproved ? '✓' : '○'}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {/* Core Role Warning */}
                {!approvalStatus.approvedRoles.includes('buyer') && !approvalStatus.approvedRoles.includes('seller') && (
                  <div className="bg-yellow-900/30 border border-yellow-600 p-3 rounded">
                    <p className="text-yellow-300 text-sm">
                      ⚠️ <strong>Warning:</strong> Neither buyer nor seller has approved yet.
                      At least one core role must approve for valid execution.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-slate-400 text-center py-4">
                {isLoadingApprovals ? 'Loading approval status...' : 'No approval data available'}
              </div>
            )}
          </section>
        )}

        {/* KHỐI 1: THÔNG TIN KÝ QUỸ */}
        <section className="bg-slate-800 p-8 rounded-2xl border border-slate-700 flex flex-col gap-4 shadow-xl">
          <div className="flex justify-between items-center border-b border-slate-700 pb-4">
            <h2 className="text-2xl font-bold tracking-wide">Escrow ID: #{escrowId || 'ESC-001'}</h2>
            <span className="bg-blue-500/20 text-blue-400 px-4 py-1.5 rounded-full text-sm font-bold border border-blue-500/50">
              {status?.toUpperCase() || 'ACTIVE'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <p className="text-slate-400 text-sm mb-1">Lock Amount</p>
              <p className="text-emerald-400 text-2xl font-bold font-mono">{normalizeDisplayAmount(escrow?.amount)} ETH</p>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between bg-slate-900/50 p-2 rounded border border-slate-700/50">
                <span className="text-slate-400 text-sm">Buyer:</span>
                <span className="text-slate-300 font-mono text-sm">{escrow?.buyer?.walletAddress || 'N/A'}</span>
              </div>
              <div className="flex justify-between bg-slate-900/50 p-2 rounded border border-slate-700/50">
                <span className="text-slate-400 text-sm">Seller:</span>
                <span className="text-slate-300 font-mono text-sm">{escrow?.seller?.walletAddress || 'N/A'}</span>
              </div>
            </div>
          </div>

          {/* ĐỒNG HỒ ĐẾM NGƯỢC QUÁ HẠN (LOCKED) */}
          {isLockedStatus && timeoutCountdown.deadlineSec != null && (() => {
            const danger = timeoutCountdown.expired;
            const warning = !danger && timeoutCountdown.remainingSec < 24 * 3600;
            // Class tĩnh để Tailwind không purge nhầm (không dùng nội suy động).
            const toneCls = danger
              ? { box: 'bg-rose-900/20 border-rose-500/40', title: 'text-rose-300', time: 'text-rose-200' }
              : warning
                ? { box: 'bg-amber-900/20 border-amber-500/40', title: 'text-amber-300', time: 'text-amber-200' }
                : { box: 'bg-emerald-900/20 border-emerald-500/40', title: 'text-emerald-300', time: 'text-emerald-200' };
            return (
              <div className={`mt-2 rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${toneCls.box}`}>
                <div>
                  <p className={`${toneCls.title} text-sm font-semibold`}>
                    {danger ? '⏰ Giao dịch đã quá hạn' : '⏳ Thời gian còn lại trước khi quá hạn'}
                  </p>
                  <p className={`${toneCls.time} text-2xl font-mono font-bold tracking-wider`}>{timeoutCountdown.formatted}</p>
                  {timeoutCountdown.deadlineDate && (
                    <p className="text-slate-400 text-xs mt-1">Hạn chót: {timeoutCountdown.deadlineDate.toLocaleString()}</p>
                  )}
                </div>
                {isParticipant && (
                  <button
                    onClick={handleTriggerTimeout}
                    disabled={!danger || isTriggeringTimeout}
                    title={!danger ? 'Chỉ có thể kích hoạt sau khi hết hạn' : 'Chuyển escrow sang DISPUTED để hội đồng phán quyết'}
                    className={`shrink-0 px-5 py-3 rounded-lg font-bold text-white transition-colors
                      ${!danger || isTriggeringTimeout
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-500/20'}`}
                  >
                    {isTriggeringTimeout ? 'Đang kích hoạt...' : 'Kích hoạt quá hạn'}
                  </button>
                )}
              </div>
            );
          })()}

          {/* ĐỒNG HỒ ĐẾM NGƯỢC HÒA GIẢI (DISPUTED) */}
          {isDisputedStatus && disputeCountdown.deadlineSec != null && (
            <div className="mt-2 rounded-xl border p-4 bg-indigo-900/20 border-indigo-500/40">
              <p className="text-indigo-300 text-sm font-semibold">
                {disputeCountdown.expired ? '⚖️ Thời hạn hòa giải đã hết — chờ hệ thống chia tiền & xử lý' : '⚖️ Thời gian hòa giải còn lại'}
              </p>
              <p className="text-indigo-200 text-2xl font-mono font-bold tracking-wider">{disputeCountdown.formatted}</p>
              {disputeCountdown.deadlineDate && (
                <p className="text-slate-400 text-xs mt-1">Hạn chót hòa giải: {disputeCountdown.deadlineDate.toLocaleString()}</p>
              )}
            </div>
          )}
        </section>

        {/* ACTIVE DISPUTE BANNER */}
        {(() => {
          const activeDsp = Array.isArray(escrow?.disputes)
            ? escrow.disputes.find(d => !['RESOLVED', 'CLOSED', 'DISMISSED'].includes(String(d.status || '').toUpperCase()))
            : null;
          if (!activeDsp) return null;
          return (
            <div className="bg-rose-900/40 border border-rose-500/60 rounded-xl p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-rose-300 font-bold text-sm">⚖️ Escrow này đang có Dispute ({String(activeDsp.status).toUpperCase()})</p>
                <p className="text-rose-400/70 text-xs mt-1">Reason: {activeDsp.reason || 'N/A'}</p>
              </div>
              <a
                href={`/disputes/${activeDsp.id}`}
                className="shrink-0 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold transition-colors"
              >
                Xem Dispute →
              </a>
            </div>
          );
        })()}

        {/* KHỐI 2: THANH TIẾN TRÌNH DKG SIGNING KEY */}
        {mediationAssigned && (
          <section className="flex flex-col gap-4">
            <div className="flex justify-between items-end">
              <h3 className="text-slate-300 font-medium text-lg">DKG Signing Key Submission Progress</h3>
              <span className="text-sm font-mono text-slate-400 bg-slate-800 px-3 py-1 rounded-md border border-slate-700">
                {progress}/7
              </span>
            </div>
            <div className="flex gap-4 justify-between bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-inner">
              {[1, 2, 3, 4, 5, 6, 7].map((num) => {
                const isNodeSigned = num <= progress;
                return (
                  <div
                    key={num}
                    className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg transition-all duration-500
                    ${isNodeSigned
                        ? 'bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.6)] scale-110'
                        : 'bg-slate-700 text-slate-500 border-2 border-slate-600'}`}
                  >
                    {num}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* KHỐI 3: TERMINAL LOGS */}
        <section className="bg-[#0A0F1C] p-5 rounded-xl border border-slate-800 h-64 overflow-y-auto font-mono text-sm shadow-2xl relative group">
          <div className="sticky top-0 bg-[#0A0F1C]/90 backdrop-blur pb-2 mb-2 border-b border-slate-800 flex justify-between items-center">
            <span className="text-slate-500 text-xs tracking-widest uppercase">System Terminal</span>
            <span className="flex gap-2">
              <span className="w-3 h-3 rounded-full bg-red-500/80"></span>
              <span className="w-3 h-3 rounded-full bg-yellow-500/80"></span>
              <span className="w-3 h-3 rounded-full bg-green-500/80"></span>
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {logs.map((log, index) => (
              <div key={index} className={`flex gap-3 hover:bg-white/5 px-2 py-1 rounded transition-colors
                ${log.type === 'success' ? 'text-emerald-400' :
                  log.type === 'error' ? 'text-red-400' :
                    log.type === 'warning' ? 'text-yellow-400' : 'text-blue-300'}`
              }>
                <span className="opacity-40 shrink-0">[{log.time}]</span>
                <span className="opacity-60">{'>'}</span>
                <span className="break-all">{log.message}</span>
              </div>
            ))}
            <div ref={logsEndRef} className="h-2" />
          </div>
        </section>

        {/* KHỐI 4.2: DKG PHASE */}
        {!hasVaultAddress && isAllowedSigner && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-purple-500/30 shadow-xl mt-4">
            <div className="flex justify-between items-center border-b border-slate-700 pb-4 mb-6">
              <h3 className="text-xl font-bold text-purple-400">Bước 1.5: Pedersen VSS DKG</h3>
              <span className={`px-3 py-1 rounded-full text-xs font-bold border ${
                isDkgComplete ? 'bg-green-900/40 border-green-500 text-green-400' :
                dkgState === DKG_STATE.ERROR ? 'bg-red-900/40 border-red-500 text-red-400' :
                dkgState === DKG_STATE.IDLE ? 'bg-slate-700 border-slate-600 text-slate-400' :
                'bg-purple-900/40 border-purple-500 text-purple-400 animate-pulse'
              }`}>
                {isDkgComplete ? 'COMPLETE' : dkgState.toUpperCase()}
              </span>
            </div>

            {/* Progress bars */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700">
                <p className="text-slate-400 text-xs mb-2">Commitments nhận được</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-purple-500 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (dkgProgress.commitmentsReceived / 7) * 100)}%` }}
                    />
                  </div>
                  <span className="text-white text-sm font-mono">{dkgProgress.commitmentsReceived}/7</span>
                </div>
              </div>
              <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700">
                <p className="text-slate-400 text-xs mb-2">Shares nhận được</p>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (dkgProgress.sharesReceived / 7) * 100)}%` }}
                    />
                  </div>
                  <span className="text-white text-sm font-mono">{dkgProgress.sharesReceived}/7</span>
                </div>
              </div>
            </div>

            {/* Signing key result */}
            {dkgResult && (
              <div className="bg-green-900/20 border border-green-600/40 p-3 rounded-lg mb-4">
                <p className="text-green-400 text-xs font-mono break-all">
                  Signing PubKey: ({dkgResult.signingPubKey?.x?.slice(0, 16)}..., {dkgResult.signingPubKey?.y?.slice(0, 16)}...)
                </p>
              </div>
            )}

            {/* Error message */}
            {dkgState === DKG_STATE.ERROR && dkgError && (
              <div className="bg-red-900/20 border border-red-600/40 p-3 rounded-lg mb-4">
                <p className="text-red-400 text-sm">{dkgError}</p>
              </div>
            )}

            {/* Action button */}
            {isDkgComplete && dkgProgress.sharesReceived >= 7 ? (
              <p className="text-center text-green-400 font-bold">✅ DKG hoàn tất — tất cả 7 parties đã đóng góp shares. Sẵn sàng Deploy.</p>
            ) : isDkgComplete && dkgProgress.sharesReceived < 7 ? (
              <p className="text-center text-yellow-400 text-sm">
                ⏳ Commitments đã đủ. Đang chờ tất cả parties nộp encrypted shares ({dkgProgress.sharesReceived}/7)...
              </p>
            ) : dkgState === DKG_STATE.IDLE || dkgState === DKG_STATE.ERROR ? (
              isAllowedSigner && dkgPrivKey ? (
                <button
                  onClick={runDkg}
                  disabled={!escrowId || !activeRole || activeRole === 'Unknown' || !dkgPrivKey}
                  className="w-full py-4 rounded-xl font-bold text-white bg-linear-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {dkgState === DKG_STATE.ERROR ? 'Retry DKG' : 'Run Pedersen VSS DKG'}
                </button>
              ) : (
                <p className="text-center text-slate-400 text-sm">
                  {!dkgPrivKey ? 'Cần có private key để chạy DKG. Hãy tạo key trước.' : 'Không đủ quyền hạn để chạy DKG.'}
                </p>
              )
            ) : (
              <div className="flex items-center justify-center gap-3 text-purple-300">
                <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">DKG đang chạy... Chờ tất cả parties hoàn thành.</span>
              </div>
            )}

            {/* Reset DKG — danger zone for when vault key mismatches signing keys */}
            {isAllowedSigner && (
              <div className="mt-4 pt-4 border-t border-red-900/30">
                <button
                  onClick={handleResetDkg}
                  disabled={isResettingDkg}
                  className="w-full py-2 rounded-lg text-xs font-semibold text-red-400 border border-red-700/50 hover:bg-red-900/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isResettingDkg ? 'Đang reset...' : '⚠ Reset DKG (xóa toàn bộ, chạy lại từ đầu)'}
                </button>
              </div>
            )}
          </section>
        )}

        {/* KHỐI 4.1: DEPLOY VAULT (CHỈ HIỆN KHI ĐÃ CÓ DKG ĐẦY ĐỦ VÀ CHƯA CÓ CONTRACT) */}
        {!hasVaultAddress && isDkgComplete && dkgProgress.sharesReceived < 7 && (
          <section className="bg-slate-800 p-6 rounded-2xl border border-yellow-500/30 shadow-sm mt-6 text-center">
            <p className="text-yellow-400 font-bold">⏳ Đang chờ tất cả parties nộp B2 shares ({dkgProgress.sharesReceived}/7)...</p>
            <p className="text-sm text-slate-400 mt-1">Deploy sẽ được mở khoá sau khi đủ 7/7 shares.</p>
          </section>
        )}
        {!hasVaultAddress && isDkgComplete && dkgProgress.sharesReceived >= 7 && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-yellow-500/30 shadow-sm mt-6">
            {activeRole === 'buyer' ? (
              <div className="flex flex-col items-center text-center gap-4">
                <h3 className="text-xl font-bold text-yellow-400">Bước 2: Triển khai Hợp đồng (Deploy)</h3>
                <p className="text-slate-300">Hợp đồng Escrow chưa được tạo trên mạng lưới Blockchain.</p>
                <p className="text-sm text-slate-400 mb-2">Với tư cách là Buyer, bạn cần ký giao dịch (trả phí Gas) để tạo Hợp đồng.</p>
                <button
                  onClick={handleDeploy}
                  disabled={isDeploying}
                  className={`px-8 py-4 w-full max-w-sm rounded-xl font-bold text-white transition-all ${isDeploying ? 'bg-amber-600 cursor-wait opacity-70' : 'bg-linear-to-r from-blue-600 to-emerald-600 hover:scale-105 shadow-lg'
                    }`}
                >
                  {isDeploying ? 'Đang Deploy (Chờ MetaMask)...' : 'Deploy Vault Contract'}
                </button>
              </div>
            ) : (
              <div className="text-center text-slate-400">
                <p className="mb-2 text-lg font-bold text-yellow-500/80">⏳ Đang chờ Buyer triển khai Hợp đồng...</p>
                <p className="text-sm text-slate-500">Sau khi Buyer tạo Hợp đồng thành công, các chức năng khác sẽ được mở khóa.</p>
              </div>
            )}
          </section>
        )}

        {/* KHỐI 4.1b: WAITING FOR DKG (non-buyer, DKG not complete) */}
        {!hasVaultAddress && !isDkgComplete && !isAllowedSigner && mediationAssigned && (
          <section className="bg-slate-800 p-6 rounded-2xl border border-slate-700 mt-6 text-center text-slate-400">
            <p className="text-lg font-bold text-yellow-500/80">⏳ Đang chờ DKG hoàn thành...</p>
            <p className="text-sm text-slate-500 mt-1">Tất cả 7 parties phải hoàn thành DKG trước khi Buyer có thể Deploy.</p>
          </section>
        )}
        {/* KHỐI 4.5 (PHASE 2): ĐỘC QUYỀN HIỂN THỊ NÚT DEPOSIT CHỈ KHI ĐÃ CÓ VAULT ADDRESS */}
        {activeRole === 'buyer' && hasVaultAddress && !isConfirmed && escrow?.status !== 'LOCKED' && !isVaultLockedOnChain && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-emerald-500/50 shadow-[0_0_30px_rgba(16,185,129,0.15)] mt-8 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <span className="text-8xl">💎</span>
            </div>
            <h3 className="text-2xl font-bold mb-4 text-emerald-400 border-b border-slate-700 pb-4 relative z-10">
              Phase 2: Lock Funds On-chain
            </h3>
            <p className="text-slate-300 mb-6 text-lg relative z-10">
              The network has successfully generated the Aggregated Public Key. As the Buyer, you need to deposit <strong>{normalizeDisplayAmount(escrow?.amount)} ETH</strong> into the Smart Contract to securely lock the funds before the execution process can be activated.
            </p>
            <button
              onClick={handleDepositFunds}
              disabled={isPending || isConfirming}
              className={`w-full py-4 rounded-xl font-bold text-white text-xl transition-all shadow-xl relative z-10
                ${isPending || isConfirming
                  ? 'bg-emerald-600/50 cursor-wait animate-pulse border border-emerald-500/50'
                  : 'bg-linear-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 transform hover:-translate-y-1'}`}
            >
              {isPending ? 'Confirming in MetaMask...' :
                isConfirming ? 'Mining Block on Ethereum...' :
                  `Deposit ${normalizeDisplayAmount(escrow?.amount)} ETH Now`}
            </button>
          </section>
        )}

        {/* KHỐI 4.8: CÁC NÚT HÀNH ĐỘNG HAPPY PATH & DISPUTE */}
        {(() => {
          const normalizedStatus = String(escrow?.status || '').toUpperCase();
          const isLocked = ['LOCKED', 'FUNDED'].includes(normalizedStatus) || isVaultLockedOnChain;
          const isResolved = normalizedStatus === 'RESOLVED';
          const isCoreRole = activeRole === 'buyer' || activeRole === 'seller';
          const isMediator = activeRole?.startsWith('mediator');

          const mediatorCanStartTss = isMediator && mediationAssigned && dkgCommitmentCount >= 7 && hasVaultAddress && !isSigningFlowClosed;
          const isDisputePhase = ['DISPUTED', 'RESOLVED'].includes(normalizedStatus);
          const canSeeActions = (isCoreRole && isLocked) || (isCoreRole && isDisputePhase) || mediatorCanStartTss || (isMediator && isDisputePhase);

          if (!canSeeActions) return null;

          // Label/color/hint for the single signing button based on determinedAction
          const actionConfig = {
            release: { label: 'Start Release (TSS)', color: 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/20', disabledColor: 'bg-emerald-800/50', hint: null },
            refund:  { label: 'Start Refund (TSS)',  color: 'bg-amber-600 hover:bg-amber-500 shadow-amber-500/20',   disabledColor: 'bg-amber-800/50',  hint: 'Dispute outcome: REFUND — refund() sends funds back to buyer' },
            split:   { label: 'Start Split (TSS)',   color: 'bg-purple-600 hover:bg-purple-500 shadow-purple-500/20', disabledColor: 'bg-purple-800/50', hint: 'Dispute outcome: SPLIT — split() divides funds 50/50' },
          };
          const cfg = actionConfig[determinedAction] || actionConfig.release;
          const resolvedDispute = Array.isArray(escrow?.disputes) ? escrow.disputes.find(d => d.status === 'RESOLVED') : null;
          const disputeOutcome = resolvedDispute?.outcome ? String(resolvedDispute.outcome).toUpperCase() : null;
          const activeDispute = Array.isArray(escrow?.disputes)
            ? escrow.disputes.find(d => !['RESOLVED', 'CLOSED', 'DISMISSED'].includes(String(d.status || '').toUpperCase()))
            : null;

          return (
            <section className={`p-6 rounded-2xl border shadow-xl mt-6 flex flex-col gap-4 justify-center items-center transition-all ${isResolved ? 'bg-indigo-900/40 border-indigo-500/50' : 'bg-slate-800 border-slate-700'}`}>

              {/* UI Blocker cho Mediator 4 và 5 */}
              {isMediator && !isAllowedSigner && (
                <div className="w-full bg-yellow-900/30 border border-yellow-600 p-3 rounded">
                  <p className="text-yellow-300 text-sm">
                    ⚠️ Not required for Happy Path — only Mediator 1, 2, 3 can sign.
                  </p>
                </div>
              )}

              {/* Dispute outcome guidance banner */}
              {isResolved && cfg.hint && (
                <div className="w-full bg-indigo-900/60 border border-indigo-500/50 rounded-xl p-4">
                  <h3 className="text-indigo-300 font-bold text-base mb-1">⚡ Dispute Finalized — {disputeOutcome?.replace(/_/g, ' ')}</h3>
                  <p className="text-sm text-slate-300">{cfg.hint}</p>
                </div>
              )}

              {/* Signing button: ẩn khi dispute đang xử lý (chưa có kết quả) */}
              {activeDispute && !resolvedDispute ? (
                <div className="w-full text-center bg-orange-900/30 border border-orange-600/50 px-4 py-3 rounded-lg">
                  <p className="text-orange-300 text-sm font-semibold">⚖️ Dispute đang được xử lý — không thể ký cho đến khi mediator ra quyết định.</p>
                </div>
              ) : (
                <>
                  {dkgCommitmentCount < 7 && (
                    <div className="w-full text-center bg-yellow-900/30 border border-yellow-600/50 px-4 py-2 rounded-lg">
                      <p className="text-yellow-300 text-sm">⏳ Chờ tất cả 7 parties hoàn thành Pedersen VSS DKG ({dkgCommitmentCount}/7 parties đã xong B1).</p>
                    </div>
                  )}
                  <button
                    onClick={() => handleStartSigning(determinedAction)}
                    disabled={dkgCommitmentCount < 7 || ['nonce', 'z-share', 'ready'].includes(signingPhase)}
                    className={`w-full md:w-auto px-8 py-3 rounded-xl text-white font-bold shadow-lg transform transition
                      ${dkgCommitmentCount < 7 || ['nonce', 'z-share', 'ready'].includes(signingPhase) ? `${cfg.disabledColor} cursor-not-allowed opacity-50` : `${cfg.color} hover:-translate-y-1`}`}
                  >
                    {['nonce', 'z-share', 'ready'].includes(signingPhase) ? 'Signing in progress...' : cfg.label}
                  </button>
                </>
              )}

              {/* Only Buyer and Seller can raise a dispute; hide once a dispute is resolved */}
              {!resolvedDispute && isCoreRole && (
                activeDispute ? (
                  <a
                    href={`/disputes/${activeDispute.id}`}
                    className="w-full md:w-auto px-6 py-3 bg-rose-700 hover:bg-rose-600 rounded-xl text-white font-bold shadow-lg text-center transform transition hover:-translate-y-1"
                  >
                    ⚖️ Xem Dispute đang mở →
                  </a>
                ) : (
                  <button
                    onClick={handleRaiseDispute}
                    className="w-full md:w-auto px-6 py-3 bg-rose-600 hover:bg-rose-500 rounded-xl text-white font-bold shadow-lg shadow-rose-500/20 transform transition hover:-translate-y-1"
                  >
                    Raise Dispute
                  </button>
                )
              )}
            </section>
          );
        })()}

        {/* KHỐI 5: LUỒNG KÝ ĐA PHẦN (TSS SIGNING ORCHESTRATION) */}
        {/* Điều kiện: Đã có Vault và (Các Role khác sẽ thấy ngay. Riêng Buyer chỉ thấy khi isConfirmed = true HOẶC db đã báo LOCKED) */}
        {hasVaultAddress && !isSigningFlowClosed && (
          ['nonce', 'z-share', 'ready'].includes(signingPhase) ||
          (mediationAssigned && progress >= 7 && (activeRole !== 'buyer' || isConfirmed || escrow?.status === 'LOCKED' || isVaultLockedOnChain))
        ) && (
            <section className="bg-slate-800 p-8 rounded-2xl border border-blue-500/30 shadow-[0_0_30px_rgba(59,130,246,0.1)] mt-8">
              <h3 className="text-xl font-bold mb-6 text-blue-400 border-b border-slate-700 pb-4">TSS Signing Orchestration</h3>

              {/* TRẠNG THÁI 1: ROUND 1 (NONCE) */}
              {signingPhase === 'nonce' && (
                <div className="flex flex-col gap-4">
                  <div className="flex justify-between items-center text-sm text-slate-300">
                    <span>Round 1: Nonce Commitment</span>
                    <span className="font-mono bg-slate-900 px-2 py-1 rounded">{signingProgress.percentage || 0}%</span>
                  </div>
                  <div className="w-full bg-slate-900 rounded-full h-2">
                    <div className="bg-blue-500 h-2 rounded-full transition-all duration-500" style={{ width: `${signingProgress.percentage || 0}%` }}></div>
                  </div>
                  <button disabled className="w-full bg-blue-600/50 py-3 rounded-lg font-bold text-white/50 cursor-wait">
                    Waiting for other nodes ({signingProgress.submitted || 0}/{signingProgress.needed || 7})...
                  </button>
                </div>
              )}

              {/* TRẠNG THÁI 2: ROUND 2 (Z-SHARE) */}
              {signingPhase === 'z-share' && (() => {
                // Round 2 signer PHẢI thuộc đúng tập đã ký Round 1 (theo signerBitmap đã khoá).
                // Người ngoài tập → z không khớp R_agg → InvalidSignature, nên disable + giải thích.
                const inRound1Set = roleInBitmap(activeRole, nonceRound1?.signerBitmap);
                const canSignRound2 = isAllowedSigner && inRound1Set;
                const zShareDisabledReason = !isAllowedSigner
                  ? 'Not authorized to sign (Mediator 4/5)'
                  : !inRound1Set
                    ? 'Bạn không tham gia Round 1 nên không thể ký Round 2 (signer set đã khoá ở Round 1).'
                    : '';
                return (
                <div className="flex flex-col gap-4">
                  <div className="flex justify-between items-center text-sm text-slate-300">
                    <span>Round 2: Partial Signature (Z-Share)</span>
                    <span className="font-mono bg-slate-900 px-2 py-1 rounded">{signingProgress.percentage || 0}%</span>
                  </div>
                  <div className="w-full bg-slate-900 rounded-full h-2">
                    <div className="bg-emerald-500 h-2 rounded-full transition-all duration-500" style={{ width: `${signingProgress.percentage || 0}%` }}></div>
                  </div>
                  <button
                    onClick={handleSubmitZShare}
                    disabled={!canSignRound2}
                    title={zShareDisabledReason}
                    className={`w-full py-3 rounded-lg font-bold text-white shadow-lg transition-colors
                    ${!canSignRound2
                        ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-500'}`}
                  >
                    {canSignRound2 ? 'Compute & Submit Z-Share' : zShareDisabledReason}
                  </button>
                </div>
                );
              })()}

              {/* TRẠNG THÁI 3: READY TO EXECUTE */}
              {signingPhase === 'ready' && aggregatedSignature && (
                <div className="flex flex-col gap-4 bg-emerald-900/20 border border-emerald-500/30 p-4 rounded-xl">
                  <p className="text-emerald-400 font-bold text-center">✓ Signature Aggregated Successfully</p>
                  <button
                    onClick={handleExecuteOnChain}
                    disabled={isPending || isConfirming || isConfirmed}
                    className={`w-full py-4 rounded-lg font-bold text-white shadow-[0_0_20px_rgba(16,185,129,0.3)] text-lg transition-all duration-300
                    ${isConfirmed ? 'bg-emerald-600 cursor-not-allowed' :
                        isPending || isConfirming ? 'bg-amber-600 cursor-wait animate-pulse' :
                          'bg-linear-to-r from-blue-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 transform hover:scale-[1.02]'}`}
                  >
                    {isPending ? 'Confirming in Wallet...' :
                      isConfirming ? 'Waiting for Block Confirmation...' :
                        isConfirmed ? 'Executed Successfully ✓' :
                          'Execute On-Chain Transaction'}
                  </button>
                </div>
              )}
            </section>
          )}

        {hasVaultAddress && isSigningFlowClosed && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-emerald-500/30 shadow-[0_0_30px_rgba(16,185,129,0.1)] mt-8">
            <h3 className="text-xl font-bold mb-4 text-emerald-400 border-b border-slate-700 pb-4">✅ Escrow Finalized</h3>
            <p className="text-slate-300">
              Giao dịch đã hoàn tất với trạng thái <strong>{isEscrowTerminal ? escrow?.status : (Number(onChainVaultStatus) === 2 ? 'RELEASED' : 'REFUNDED')}</strong>.
              Luồng ký và thực thi đã đóng.
            </p>
            {finalTxHash && (
              <a
                href={`https://sepolia.etherscan.io/tx/${finalTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 transition-colors font-mono text-sm break-all"
              >
                🔗 Xem giao dịch trên Etherscan: {String(finalTxHash).slice(0, 18)}...
              </a>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

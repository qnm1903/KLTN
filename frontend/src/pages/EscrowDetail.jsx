import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { useAccount } from 'wagmi';
import { ethers } from 'ethers';

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
import { useTssWorker } from '../features/escrow/useTssWorker'; // Tích hợp Phase 5: Web Worker

// --- IMPORT API & STORAGE ---
import api from '../lib/api';
import { clearPrivKey, getPubKey, getPrivKey, unlockEncryptedPrivKey } from '../lib/storage';
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

// Helper: Validate signerBitmap - buyer OR seller must be included
function validateSignerBitmap(bitmap) {
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
  if ((b & CORE_ROLE_MASK) === 0) return { valid: false, error: 'At least one core role (buyer or seller) must approve' };
  return { valid: true };
}

export default function EscrowDetail() {
  // 1. Lấy Context & Định danh
  const { id: escrowId } = useParams();
  const { address } = useAccount();

  const [escrow, setEscrow] = useState(null);
  const [isEscrowLoading, setIsEscrowLoading] = useState(true);
  const [isSubmittingKey, setIsSubmittingKey] = useState(false);
  const [onChainVaultStatus, setOnChainVaultStatus] = useState(null);
  const [approvalStatus, setApprovalStatus] = useState(null);
  const [isLoadingApprovals, setIsLoadingApprovals] = useState(false);
  const addLog = useSetAtom(addSystemLogAtom);
  const setNonceRound1 = useSetAtom(nonceRound1Atom);
  const setSigningPhase = useSetAtom(signingPhaseAtom);

  // 2. Khởi tạo Logic Chạy ngầm (Cập nhật lấy thêm deployEscrowVault)
  const { isRecovering } = useSessionRecovery(escrowId, address);
  const { submitPubKey, submitNonce, submitZShare, resetSigning } = useEscrowSync(escrowId, escrow?.status);
  const { executeTssAction, fundEscrow, getVaultStatus, isPending, isConfirming, isConfirmed, deployEscrowVault, waitForTx, hash: hookTxHash } = useContractCall();
  const { computeNonce, computeZShare, hasNonce, clearNonce } = useTssWorker(); // Khởi tạo Web Worker Hook

  // 3. Đọc State từ Jotai để render UI
  const status = useAtomValue(escrowStatusAtom);
  const progress = useAtomValue(signatureProgressAtom);
  const setProgress = useSetAtom(signatureProgressAtom);
  const logs = useAtomValue(systemLogsAtom);
  const signedNodes = useAtomValue(signedNodesAtom);
  const setSignedNodes = useSetAtom(signedNodesAtom);
  const signingPhase = useAtomValue(signingPhaseAtom);
  const signingProgress = useAtomValue(signingProgressAtom);
  const aggregatedSignature = useAtomValue(aggregatedSignatureAtom);
  const selectedAction = useAtomValue(selectedActionAtom);
  const nonceRound1 = useAtomValue(nonceRound1Atom);
  const setSelectedAction = useSetAtom(selectedActionAtom);

  const { login } = useSIWE();
  const hasLocalToken = Boolean(getStoredAccessToken());

  const activeRole = useMemo(() => {
    return resolveRoleFromEscrow(escrow, address);
  }, [escrow, address]);

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

  const hasSubmitted = activeRole !== 'Unknown' && signedNodes.includes(activeRole);
  const localPubKey = getPubKey(address);
  const isVaultLockedOnChain = onChainVaultStatus !== null && Number(onChainVaultStatus) >= 1;
  const isVaultTerminalOnChain = onChainVaultStatus !== null && [2, 3].includes(Number(onChainVaultStatus));
  const isEscrowTerminal = ['RELEASED', 'REFUNDED'].includes(String(escrow?.status || '').toUpperCase());
  const isSigningFlowClosed = isVaultTerminalOnChain || isEscrowTerminal;
  
  // Cờ kiểm tra tính độc quyền UI (Mutually Exclusive)
  const hasVaultAddress = Boolean(escrow?.contractAddress || escrow?.vaultAddress);

  // Auto-scroll cho Terminal & Biến cờ Auto-Submit (Phase 1)
  const logsEndRef = useRef(null);
  const autoSubmitAttempted = useRef(false);

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
          setSignedNodes(['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5']);
        }
      } catch (error) {
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
      } catch (error) {
        if (!active) return;
      }
    };

    checkOnChainStatus();
    return () => {
      active = false;
    };
  }, [escrow?.contractAddress, escrow?.vaultAddress]);

  // --- CÁC HÀM XỬ LÝ HÀNH ĐỘNG ---
const handleSubmitMyPubKey = useCallback(async () => {
    if (activeRole === 'Unknown') return alert('Cannot resolve your escrow role.');
    if (!localPubKey) return alert('Public key not found. Please generate your key first.');

    setIsSubmittingKey(true);
    try {
      await submitPubKey({ role: activeRole, pubKey: localPubKey });
    } catch (error) {
      const status = error.response?.status;
      if (status === 409) {
        console.warn(`[DKG] Pubkey conflict ignored for ${activeRole}. It was likely submitted previously.`);
      } else {
        alert(error.response ? `Backend Error: ${JSON.stringify(error.response.data)}` : `Error: ${error.message}`);
      }
    } finally {
      setIsSubmittingKey(false);
    }
  }, [activeRole, localPubKey, submitPubKey, addLog]);

  // --- BẢN VÁ PHASE 1: LUỒNG AUTO-SUBMIT KEY ---
  useEffect(() => {
    if (isEscrowLoading || isRecovering) return;

    if (hasVaultAddress) {
      return; 
    }

    const escrowStatus = String(escrow?.status || '').toUpperCase();
    const dkgAllowed = ['DRAFT', 'INITIALIZED', 'LOCKED', 'DISPUTED'].includes(escrowStatus);
    
    if (!dkgAllowed) return;
    if (activeRole === 'Unknown' || !localPubKey || hasSubmitted || isSubmittingKey || progress >= 7 || autoSubmitAttempted.current) return;
    
    autoSubmitAttempted.current = true;
    handleSubmitMyPubKey();
     
  }, [isEscrowLoading, isRecovering, escrow?.status, activeRole, localPubKey, hasSubmitted, progress, isSubmittingKey]);

  
  const lastLogRef = useRef(0);

  useEffect(() => {
    try {
      const now = Date.now();
      // Chỉ log tối đa 1 lần mỗi 1000ms (1 giây)
      if (now - lastLogRef.current < 1000) return;
      lastLogRef.current = now;

      const mediatorCount = escrow?.escrowMediators?.length || 0;
      const table = [
        { Biến: 'DKG Progress', Giá_trị: progress },
        { Biến: 'Trạng thái Escrow', Giá_trị: escrow?.status ?? 'Chưa có' },
        { Biến: 'Số lượng Trọng tài', Giá_trị: mediatorCount },
        { Biến: 'Vai trò hiện tại (Role)', Giá_trị: activeRole },
        { Biến: 'Đã có LocalPubKey?', Giá_trị: Boolean(localPubKey) },
        { Biến: 'Đã Submit (hasSubmitted)?', Giá_trị: hasSubmitted },
        { Biến: 'Đã chặn Auto-Submit (Attempted)?', Giá_trị: !!autoSubmitAttempted.current }
      ];
      console.group('🚀 [STATE MONITOR] THEO DÕI DEADLOCK');
      console.table(table);
      console.groupEnd();
    } catch (err) {}
  }, [progress, escrow?.status, escrow?.escrowMediators?.length, activeRole, localPubKey, hasSubmitted]);

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

      // 2) Lấy khóa tổng hợp pkAgg đã được sinh ra từ bước DKG
      const { data: agg } = await api.get(`/escrow/${escrowId}/aggregate-key`);
      const coords = agg?.pkAggCoords || agg?.pkAggReleaseCoords; 
      if (!coords || coords.length !== 2) {
        throw new Error('Aggregated public key missing. DKG not completed.');
      }
      
      const x = BigInt(coords[0]);
      const y = BigInt(coords[1]);
      if (x === 0n || y === 0n) throw new Error('Aggregated key invalid (zero).');

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

        if (receipt && receipt.status === 0) {
          throw new Error('Transaction reverted on the blockchain.');
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
      // Xóa bỏ đoạn Fallback reload ở đây, chỉ in log lỗi
      console.error('[handleDeploy] Lỗi tàn khốc:', err);
      const msg = err?.response?.data?.error || err?.message || String(err);
      addLog({ message: `Lỗi Deploy: ${msg}`, type: 'error' });
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

  // Fetch approval status when selected action changes
  useEffect(() => {
    if (selectedAction) {
      fetchApprovalStatus(selectedAction);
    }
  }, [selectedAction, fetchApprovalStatus]);

  const handleStartRelease = async () => {
    if (isSigningFlowClosed) {
      addLog({ message: 'Release flow is closed because this vault is already finalized.', type: 'warning' });
      return;
    }
    const action = 'release';
    setSelectedAction(action);

    try {
      const nonceKey = buildNonceKey(action);
      if (!nonceKey) throw new Error('Cannot start Round 1: unresolved escrow/action/role context');

      const { R_x, R_y } = await computeNonce(nonceKey);

      const safe_R_x = extractTrueHex(R_x);
      const safe_R_y = extractTrueHex(R_y);

      // Backend will calculate signerBitmap from actual submitted roles
      addLog({ message: `Submitting nonce for action: ${action}...`, type: 'info' });
      const nonceResponse = await submitNonce(escrowId, activeRole, action, 0, safe_R_x, safe_R_y);

      // Use signerBitmap from backend response
      const actualSignerBitmap = nonceResponse.signerBitmap;
      addLog({ message: `Backend confirmed signerBitmap: ${actualSignerBitmap}`, type: 'info' });

      // If Round 1 is already complete, set nonceRound1 atom and transition to Round 2
      if (nonceResponse.state === 'round2_ready' && nonceResponse.round2Context) {
        setNonceRound1(nonceResponse.round2Context);
        setSigningPhase('z-share');
        addLog({ message: `Round 1 already complete. You can proceed to Round 2.`, type: 'success' });
      }
      
      // If backend reports nonce mismatch, clear local nonce and warn user
      if (nonceResponse.state === 'round1_in_progress' && nonceResponse.existingNonce) {
        const nonceKey = buildNonceKey(action);
        if (nonceKey) {
          await clearNonce(nonceKey);
          addLog({ message: `⚠️ Local nonce cleared. All participants must restart signing with fresh nonces.`, type: 'error' });
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const exactError = error.response?.data?.error || error.message;
      
      // Handle 409 conflict - different action or bitmap in progress
      if (status === 409) {
        addLog({ message: `⚠️ ${exactError}`, type: 'warning' });
        // Don't block UI - user can continue with Round 2 if they have nonce stored locally
      } else {
        addLog({ message: `[Lỗi Backend]: ${exactError}`, type: 'error' });
      }
    }
  };

  const handleStartRefund = async () => {
    if (isSigningFlowClosed) {
      addLog({ message: 'Refund flow is closed because this vault is already finalized.', type: 'warning' });
      return;
    }
    const action = 'refund';
    setSelectedAction(action);

    try {
      const nonceKey = buildNonceKey(action);
      if (!nonceKey) throw new Error('Cannot start Round 1: unresolved escrow/action/role context');

      const { R_x, R_y } = await computeNonce(nonceKey);

      const safe_R_x = extractTrueHex(R_x);
      const safe_R_y = extractTrueHex(R_y);

      // Backend will calculate signerBitmap from actual submitted roles
      addLog({ message: `Submitting nonce for action: ${action}...`, type: 'info' });
      const nonceResponse = await submitNonce(escrowId, activeRole, action, 0, safe_R_x, safe_R_y);

      // Use signerBitmap from backend response
      const actualSignerBitmap = nonceResponse.signerBitmap;
      addLog({ message: `Backend confirmed signerBitmap: ${actualSignerBitmap}`, type: 'info' });

      // If Round 1 is already complete, set nonceRound1 atom and transition to Round 2
      if (nonceResponse.state === 'round2_ready' && nonceResponse.round2Context) {
        setNonceRound1(nonceResponse.round2Context);
        setSigningPhase('z-share');
        addLog({ message: `Round 1 already complete. You can proceed to Round 2.`, type: 'success' });
      }
      
      // If backend reports nonce mismatch, clear local nonce and warn user
      if (nonceResponse.state === 'round1_in_progress' && nonceResponse.existingNonce) {
        const nonceKey = buildNonceKey(action);
        if (nonceKey) {
          await clearNonce(nonceKey);
          addLog({ message: `⚠️ Local nonce cleared. All participants must restart signing with fresh nonces.`, type: 'error' });
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const exactError = error.response?.data?.error || error.message;
      
      // Handle 409 conflict - different action or bitmap in progress
      if (status === 409) {
        addLog({ message: `⚠️ ${exactError}`, type: 'warning' });
        // Don't block UI - user can continue with Round 2 if they have nonce stored locally
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
      const validation = validateSignerBitmap(signerBitmap, []);
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

      const { z } = await computeZShare(privateKeyHex, challengeHex, nonceKey);

      clearPrivKey(address);
      
      addLog({ message: `✅ Round 2 Z-Share computed successfully with real challenge: ${challengeHex}`, type: 'info' });
      addLog({ message: `📝 Submitting Z-Share with signerBitmap: ${signerBitmap}`, type: 'info' });
      
      await submitZShare(escrowId, activeRole, signerBitmap, z);
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
    await executeTssAction(selectedAction, aggregatedSignature, backupAddress);

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
                          className={`px-3 py-1 rounded-full text-sm font-medium border ${
                            isApproved 
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
        </section>

        {/* KHỐI 2: THANH TIẾN TRÌNH TSS 5-OF-7 */}
        {mediationAssigned && (
        <section className="flex flex-col gap-4">
          <div className="flex justify-between items-end">
            <h3 className="text-slate-300 font-medium text-lg">Public Key Collection Progress</h3>
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

        {/* KHỐI 4: CỤM NÚT HÀNH ĐỘNG PUBKEY */}
        {mediationAssigned &&progress < 7 && (
          <section className="flex gap-6 justify-center mt-4">
            <button 
              onClick={handleSubmitMyPubKey}
              disabled={hasSubmitted || isSubmittingKey || progress >= 7 || activeRole === 'Unknown' || !localPubKey}
              className={`px-8 py-4 rounded-xl font-bold transition-all duration-300 w-56 flex items-center justify-center gap-2
                ${hasSubmitted || progress >= 7 || activeRole === 'Unknown' || !localPubKey
                  ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed' 
                  : isSubmittingKey 
                    ? 'bg-blue-600/50 cursor-wait border border-blue-500/50' 
                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/25 border border-blue-500'}`}
            >
              {isSubmittingKey && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>}
              {isSubmittingKey ? 'Submitting...' : hasSubmitted ? 'Pubkey Submitted ✓' : !localPubKey ? 'Generate Key First' : 'Submit My Pubkey'}
            </button>

            <a
              href="/generate-key"
              className="px-8 py-4 rounded-xl font-bold transition-all duration-300 w-64 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_30px_rgba(16,185,129,0.4)] border border-emerald-500"
            >
              Generate / Rotate Key
            </a>
          </section>
        )}
        {/* KHỐI 4.1: DEPLOY VAULT (CHỈ HIỆN KHI CHƯA CÓ CONTRACT) */}
        {!hasVaultAddress && progress >= 7 && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-yellow-500/30 shadow-sm mt-6">
            {activeRole === 'buyer' ? (
              <div className="flex flex-col items-center text-center gap-4">
                <h3 className="text-xl font-bold text-yellow-400">Bước 1: Triển khai Hợp đồng (Deploy)</h3>
                <p className="text-slate-300">Hợp đồng Escrow chưa được tạo trên mạng lưới Blockchain.</p>
                <p className="text-sm text-slate-400 mb-2">Với tư cách là Buyer, bạn cần ký giao dịch (trả phí Gas) để tạo Hợp đồng.</p>
                <button
                  onClick={handleDeploy}
                  disabled={isDeploying}
                  className={`px-8 py-4 w-full max-w-sm rounded-xl font-bold text-white transition-all ${
                    isDeploying ? 'bg-amber-600 cursor-wait opacity-70' : 'bg-linear-to-r from-blue-600 to-emerald-600 hover:scale-105 shadow-lg'
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

          const mediatorCanStartTss = isMediator && mediationAssigned && progress >= 5 && hasVaultAddress && !isSigningFlowClosed;
          const isDisputePhase = ['DISPUTED', 'RESOLVED'].includes(normalizedStatus);
          const canSeeActions = (isCoreRole && isLocked) || (isCoreRole && isDisputePhase) || mediatorCanStartTss || (isMediator && isDisputePhase);

          if (!canSeeActions) return null;

          return (
            <section className={`p-6 rounded-2xl border shadow-xl mt-6 flex flex-col md:flex-row gap-4 justify-center items-center transition-all ${isResolved ? 'bg-indigo-900/40 border-indigo-500/50' : 'bg-slate-800 border-slate-700'}`}>
              
              {/* Context Banner for Dispute Phase */}
              {isResolved && (
                <div className="w-full text-center md:w-auto md:mr-auto">
                  <h3 className="text-indigo-400 font-bold text-lg mb-1">⚡ Dispute Finalized</h3>
                  <p className="text-sm text-slate-300">Click the action matching the final outcome to begin TSS Signing.</p>
                </div>
              )}
              
              <button
                onClick={handleStartRelease}
                className="w-full md:w-auto px-6 py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-bold shadow-lg shadow-emerald-500/20 transform transition hover:-translate-y-1"
              >
                Start Release (TSS)
              </button>

              <button
                onClick={handleStartRefund}
                className="w-full md:w-auto px-6 py-3 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-bold shadow-lg shadow-amber-500/20 transform transition hover:-translate-y-1"
              >
                Start Refund (TSS)
              </button>

              {/* Only Buyer and Seller can raise a dispute, not mediators */}
              {!isResolved && isCoreRole && (
                <button
                  onClick={handleRaiseDispute}
                  className="w-full md:w-auto px-6 py-3 bg-rose-600 hover:bg-rose-500 rounded-xl text-white font-bold shadow-lg shadow-rose-500/20 transform transition hover:-translate-y-1"
                >
                  Raise Dispute
                </button>
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
            {signingPhase === 'z-share' && (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between items-center text-sm text-slate-300">
                  <span>Round 2: Partial Signature (Z-Share)</span>
                  <span className="font-mono bg-slate-900 px-2 py-1 rounded">{signingProgress.percentage || 0}%</span>
                </div>
                <div className="w-full bg-slate-900 rounded-full h-2">
                  <div className="bg-emerald-500 h-2 rounded-full transition-all duration-500" style={{ width: `${signingProgress.percentage || 0}%` }}></div>
                </div>
                <button onClick={handleSubmitZShare} className="w-full bg-emerald-600 hover:bg-emerald-500 py-3 rounded-lg font-bold text-white shadow-lg">
                  Compute & Submit Z-Share
                </button>
              </div>
            )}

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

        {progress >= 7 && hasVaultAddress && isSigningFlowClosed && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-emerald-500/30 shadow-[0_0_30px_rgba(16,185,129,0.1)] mt-8">
            <h3 className="text-xl font-bold mb-4 text-emerald-400 border-b border-slate-700 pb-4">Escrow Finalized</h3>
            <p className="text-slate-300">
              This escrow has already been finalized as <strong>{isEscrowTerminal ? escrow?.status : (Number(onChainVaultStatus) === 2 ? 'RELEASED' : 'REFUNDED')}</strong>.
              The signing and execution flow is closed.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

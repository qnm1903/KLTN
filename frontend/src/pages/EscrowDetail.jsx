import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { useConnection } from 'wagmi';

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
  selectedActionAtom
} from '../features/escrow/escrowStore';
import { useEscrowSync } from '../features/escrow/useEscrowSync';
import { useSessionRecovery } from '../features/escrow/useSessionRecovery';
import { useContractCall } from '../features/escrow/useContractCall'; 
import { useTssWorker } from '../features/escrow/useTssWorker'; // Tích hợp Phase 5: Web Worker

// --- IMPORT API & STORAGE ---
import api from '../lib/api';
import { getPubKey } from '../lib/storage';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveRoleFromEscrow(escrow, walletAddress) {
  const normalizedWalletAddress = normalizeAddress(walletAddress);
  if (!normalizedWalletAddress || !escrow) return 'Unknown';

  if (normalizeAddress(escrow?.buyer?.walletAddress) === normalizedWalletAddress) return 'buyer';
  if (normalizeAddress(escrow?.seller?.walletAddress) === normalizedWalletAddress) return 'seller';

  const mediatorRow = (escrow?.escrowMediators || []).find(
    (row) => normalizeAddress(row?.mediator?.walletAddress) === normalizedWalletAddress
  );

  if (mediatorRow?.slot) return `mediator${mediatorRow.slot}`;

  return 'Unknown';
}

function normalizeDisplayAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return '0';
  return String(amount);
}

export default function EscrowDetail() {
  // 1. Lấy Context & Định danh
  const { id: escrowId } = useParams();
  const { address } = useConnection();

  const [escrow, setEscrow] = useState(null);
  const [isEscrowLoading, setIsEscrowLoading] = useState(true);
  const [isSubmittingKey, setIsSubmittingKey] = useState(false);
  const addLog = useSetAtom(addSystemLogAtom);

  // 2. Khởi tạo Logic Chạy ngầm (Cập nhật lấy thêm fundEscrow)
  const { isRecovering } = useSessionRecovery(escrowId, address);
  const { submitPubKey, submitNonce, submitZShare } = useEscrowSync(escrowId);
  const { executeTssAction, fundEscrow, isPending, isConfirming, isConfirmed } = useContractCall(); 
  const { computeNonce, computeZShare } = useTssWorker(); // Khởi tạo Web Worker Hook

  // 3. Đọc State từ Jotai để render UI
  const status = useAtomValue(escrowStatusAtom);
  const progress = useAtomValue(signatureProgressAtom);
  const logs = useAtomValue(systemLogsAtom);
  const signedNodes = useAtomValue(signedNodesAtom);
  const signingPhase = useAtomValue(signingPhaseAtom);
  const signingProgress = useAtomValue(signingProgressAtom);
  const aggregatedSignature = useAtomValue(aggregatedSignatureAtom);
  const selectedAction = useAtomValue(selectedActionAtom);
  const setSelectedAction = useSetAtom(selectedActionAtom);

  const activeRole = useMemo(() => {
    return resolveRoleFromEscrow(escrow, address);
  }, [escrow, address]);

  const hasSubmitted = activeRole !== 'Unknown' && signedNodes.includes(activeRole);
  const localPubKey = getPubKey(address);

  // Auto-scroll cho Terminal & Biến cờ Auto-Submit (Phase 1)
  const logsEndRef = useRef(null);
  const autoSubmitAttempted = useRef(false);

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
      } catch (error) {
        if (!active) return;
        addLog({ message: `Cannot load escrow detail: ${error.message}`, type: 'error' });
      } finally {
        if (active) setIsEscrowLoading(false);
      }
    };

    fetchEscrowDetail();
    return () => { active = false; };
  }, [escrowId, addLog]);

  // --- CÁC HÀM XỬ LÝ HÀNH ĐỘNG ---
  const handleSubmitMyPubKey = async () => {
    if (activeRole === 'Unknown') return alert('Cannot resolve your escrow role.');
    if (!localPubKey) return alert('Public key not found. Please generate your key first.');

    setIsSubmittingKey(true);
    try {
      await submitPubKey({ role: activeRole, pubKey: localPubKey });
    } catch (error) {
      alert(error.response ? `Backend Error: ${JSON.stringify(error.response.data)}` : `Error: ${error.message}`);
    } finally {
      setIsSubmittingKey(false);
    }
  };

  // --- BẢN VÁ PHASE 1: LUỒNG AUTO-SUBMIT KEY ---
  useEffect(() => {
    if (
      activeRole !== 'Unknown' &&
      localPubKey &&
      !hasSubmitted &&
      !isSubmittingKey &&
      progress < 7 &&
      !autoSubmitAttempted.current
    ) {
      autoSubmitAttempted.current = true;
      addLog({ message: 'Auto-submitting local Public Key...', type: 'info' });
      handleSubmitMyPubKey();
    }
  }, [activeRole, localPubKey, hasSubmitted, progress, isSubmittingKey, addLog]);

  // --- BẢN VÁ PHASE 2: LUỒNG NẠP TIỀN CHO BUYER ---
  const handleDepositFunds = async () => {
    try {
      // Fallback: API Contract Address -> API Vault Address -> Local ENV
      const vaultAddress = escrow?.contractAddress || escrow?.vaultAddress || import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS; 
      if (!vaultAddress) {
         addLog({ message: "Smart Contract address is missing. Please setup VITE_ESCROW_CONTRACT_ADDRESS in .env", type: 'error' });
         return;
      }
      await fundEscrow(vaultAddress, escrow?.amount);
    } catch (error) {
      addLog({ message: `Deposit action failed: ${error.message}`, type: 'error' });
    }
  };

  const handleStartRelease = async () => {
    setSelectedAction('release');
    try {
      // Offload tính toán ECC sang Web Worker
      const { R_x, R_y } = await computeNonce();
      
      const dummySignerBitmap = 127; // Tạm thời giữ nguyên bitmap theo yêu cầu DTO
      await submitNonce(escrowId, activeRole, 'release', dummySignerBitmap, R_x, R_y);
    } catch (error) {
      addLog({ message: `Failed to start release: ${error.message}`, type: 'error' });
    }
  };

  const handleStartRefund = async () => {
    setSelectedAction('refund');
    try {
      // Offload tính toán ECC sang Web Worker giống hệt luồng Release
      const { R_x, R_y } = await computeNonce();
      
      const dummySignerBitmap = 127; // Tạm thời giữ nguyên bitmap theo yêu cầu DTO
      
      // Gọi API với action là 'refund'
      await submitNonce(escrowId, activeRole, 'refund', dummySignerBitmap, R_x, R_y);
      addLog({ message: `Đã khởi tạo tiến trình Hoàn tiền. Đang chờ các node khác...`, type: 'info' });
    } catch (error) {
      addLog({ message: `Failed to start refund: ${error.message}`, type: 'error' });
    }
  };

  const handleSubmitZShare = async () => {
    try {
      // Offload tính toán phương trình Schnorr sang Web Worker
      const { z } = await computeZShare();
      
      const dummySignerBitmap = 127;
      await submitZShare(escrowId, activeRole, dummySignerBitmap, z);
    } catch (error) {
      addLog({ message: `Failed to submit Z-Share: ${error.message}`, type: 'error' });
    }
  };

  // Hàm gọi Smart Contract sau khi có bộ chữ ký tổng hợp
  const handleExecuteOnChain = async () => {
    try {
      if (!aggregatedSignature) throw new Error("Missing aggregated signature");
      
      // Truyền selectedAction (có giá trị 'release' hoặc 'refund') vào hàm
      await executeTssAction(selectedAction, aggregatedSignature);
      
    } catch (error) {
      addLog({ message: `On-chain execution failed: ${error.message}`, type: 'error' });
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
        {/* --- BẮT ĐẦU BẢNG DEBUG (SAU KHI FIX XONG SẼ XÓA) --- */}
        <div className="bg-red-900 text-yellow-300 p-6 rounded-xl font-mono text-sm border-2 border-yellow-500 shadow-2xl mb-4">
          <h3 className="text-xl font-bold text-white mb-4 border-b border-red-700 pb-2">🔍 X-RAY DEBUG PANEL</h3>
          <div className="grid grid-cols-2 gap-2">
            <p>1. Tiến trình DKG (progress): <span className="text-white">{progress}/7</span></p>
            <p>2. Vai trò hiện tại (activeRole): <span className="text-white px-2 bg-black/50">{activeRole}</span></p>
            <p>3. Ví đang kết nối (address): <span className="text-white">{address || 'Chưa kết nối'}</span></p>
            <p>4. Ví Buyer trên DB (escrow.buyer): <span className="text-white">{escrow?.buyer?.walletAddress || 'Đang tải...'}</span></p>
            <p>5. Trạng thái DB (escrow.status): <span className="text-white">{escrow?.status || 'Đang tải...'}</span></p>
            <p>6. Đã xác nhận Tx (isConfirmed): <span className="text-white">{String(isConfirmed)}</span></p>
          </div>
          <div className="mt-4 pt-4 border-t border-red-700 text-lg">
            <p>=&gt; Nút Deposit có được phép hiện không?: 
              <span className={progress >= 7 && activeRole === 'buyer' && !isConfirmed && escrow?.status !== 'FUNDED' ? "text-green-400 ml-2 font-bold" : "text-red-400 ml-2 font-bold"}>
                {String(progress >= 7 && activeRole === 'buyer' && !isConfirmed && escrow?.status !== 'FUNDED')}
              </span>
            </p>
          </div>
        </div>
        {/* --- KẾT THÚC BẢNG DEBUG --- */}
        
        {/* BẢN VÁ PHASE 1: CẢNH BÁO THIẾU KEY (Rất quan trọng cho E2E Testing) */}
        {!localPubKey && address && (
          <div className="bg-red-900/50 border-2 border-red-500 p-6 rounded-xl shadow-[0_0_20px_rgba(239,68,68,0.3)] flex flex-col items-center gap-3">
            <h3 className="text-red-400 font-bold text-xl uppercase tracking-widest">⚠️ Missing Local Keypair</h3>
            <p className="text-red-200 text-center">
              Profile trình duyệt này chưa được khởi tạo Private/Public Key. Bạn không thể tham gia mạng lưới TSS.
            </p>
            <a href="/generate-key" className="mt-2 px-8 py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-lg transition-colors">
              Go to Key Generator
            </a>
          </div>
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
        {progress < 7 && (
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

        {/* BẢN VÁ PHASE 2: KHỐI 4.5 - NẠP TIỀN ON-CHAIN (CHỈ HIỂN THỊ KHI CHƯA XÁC NHẬN NẠP) */}
        {progress >= 7 && activeRole === 'buyer' && !isConfirmed && escrow?.status !== 'FUNDED' && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-emerald-500/50 shadow-[0_0_30px_rgba(16,185,129,0.15)] mt-8 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <span className="text-8xl">💎</span>
            </div>
            <h3 className="text-2xl font-bold mb-4 text-emerald-400 border-b border-slate-700 pb-4 relative z-10">
              Phase 2: Lock Funds On-chain
            </h3>
            <p className="text-slate-300 mb-6 text-lg relative z-10">
              Mạng lưới đã khởi tạo Khóa tổng hợp (Aggregated Address) thành công. Là Người Mua (Buyer), bạn cần nạp <strong>{normalizeDisplayAmount(escrow?.amount)} ETH</strong> vào Smart Contract để quỹ được khóa an toàn trước khi có thể kích hoạt tiến trình giải ngân.
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

        {/* KHỐI 5: LUỒNG KÝ ĐA PHẦN (TSS SIGNING ORCHESTRATION) */}
        {/* Điều kiện: Các Role khác sẽ thấy ngay. Riêng Buyer chỉ thấy khi isConfirmed = true HOẶC db đã báo FUNDED */}
        {progress >= 7 && (activeRole !== 'buyer' || isConfirmed || escrow?.status === 'FUNDED') && (
          <section className="bg-slate-800 p-8 rounded-2xl border border-blue-500/30 shadow-[0_0_30px_rgba(59,130,246,0.1)] mt-8">
            <h3 className="text-xl font-bold mb-6 text-blue-400 border-b border-slate-700 pb-4">TSS Signing Orchestration</h3>
            
            {/* TRẠNG THÁI 0: CHỌN HÀNH ĐỘNG */}
            {!signingPhase && (
              <div className="flex gap-4">
                <button onClick={handleStartRelease} className="flex-1 bg-emerald-600 hover:bg-emerald-500 py-3 rounded-lg font-bold text-white shadow-lg">
                  Start Release (Giải ngân)
                </button>
                <button onClick={handleStartRefund} className="flex-1 bg-amber-600 hover:bg-amber-500 py-3 rounded-lg font-bold text-white shadow-lg">
                  Start Refund (Hoàn tiền)
                </button>
              </div>
            )}

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
      </main>
    </div>
  );
}
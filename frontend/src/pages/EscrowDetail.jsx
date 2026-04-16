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
import { useContractCall } from '../features/escrow/useContractCall'; // Tích hợp Phase 4

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

  // 2. Khởi tạo Logic Chạy ngầm
  const { isRecovering } = useSessionRecovery(escrowId, address);
  const { submitPubKey, submitNonce, submitZShare } = useEscrowSync(escrowId);
  const { executeRelease, isPending, isConfirming, isConfirmed } = useContractCall(); // Hook gọi Smart Contract

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

  // Auto-scroll cho Terminal
  const logsEndRef = useRef(null);
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

  const handleStartRelease = async () => {
    setSelectedAction('release');
    try {
      const dummySignerBitmap = 127;
      const dummyRx = "0x" + "1".repeat(64);
      const dummyRy = "0x" + "2".repeat(64);
      await submitNonce(escrowId, activeRole, 'release', dummySignerBitmap, dummyRx, dummyRy);
    } catch (error) {
      addLog({ message: `Failed to start release: ${error.message}`, type: 'error' });
    }
  };

  const handleStartRefund = async () => {
    setSelectedAction('refund');
    // Implement tương tự release trong tương lai
  };

  const handleSubmitZShareMock = async () => {
    try {
      const dummySignerBitmap = 127;
      const dummyZ = "0x" + "3".repeat(64);
      await submitZShare(escrowId, activeRole, dummySignerBitmap, dummyZ);
    } catch (error) {
      addLog({ message: `Failed to submit Z-Share: ${error.message}`, type: 'error' });
    }
  };

  // Hàm gọi Smart Contract sau khi có bộ chữ ký tổng hợp
  const handleExecuteOnChain = async () => {
    try {
      if (!aggregatedSignature) throw new Error("Missing aggregated signature");
      await executeRelease(aggregatedSignature);
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

        {/* KHỐI 5: LUỒNG KÝ ĐA PHẦN (TSS SIGNING ORCHESTRATION) */}
        {progress >= 7 && (
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
                <button onClick={handleSubmitZShareMock} className="w-full bg-emerald-600 hover:bg-emerald-500 py-3 rounded-lg font-bold text-white shadow-lg">
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
import React, { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';

// --- IMPORT STATE & LOGIC HOOKS ---
import { 
  escrowStatusAtom, 
  signatureProgressAtom, 
  systemLogsAtom, 
  signedNodesAtom 
} from '../features/escrow/escrowStore';
import { useTssWorker } from '../features/escrow/useTssWorker';
import { useEscrowSync } from '../features/escrow/useEscrowSync';
import { useSessionRecovery } from '../features/escrow/useSessionRecovery';

// --- IMPORT WEB3 & API ---
import api from '../lib/api';
import { vaultAbi } from '../lib/abis'; // Đã dùng chuẩn vaultAbi cho thao tác Release

export default function EscrowDetail() {
  // 1. Lấy Context & Định danh
  const { id: escrowId } = useParams();
  const [searchParams] = useSearchParams();
  const role = searchParams.get('role') || 'Unknown'; 
  const mockUserAddress = `${role}_0x123...`; // Giả lập để test 3 tab

  // 2. Khởi tạo Logic Chạy ngầm
  const { isRecovering } = useSessionRecovery(escrowId);
  const { generateSignatureShare } = useTssWorker();
  const { submitSignature } = useEscrowSync(escrowId);

  // 3. Đọc State từ Jotai để render UI
  const status = useAtomValue(escrowStatusAtom);
  const progress = useAtomValue(signatureProgressAtom);
  const logs = useAtomValue(systemLogsAtom);
  const signedNodes = useAtomValue(signedNodesAtom);

  // Auto-scroll cho Terminal
  const logsEndRef = useRef(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // 4. Local State cho các Nút bấm
  const [isSigning, setIsSigning] = useState(false);
  const hasSigned = signedNodes.includes(mockUserAddress);
  const [isFetchingSignature, setIsFetchingSignature] = useState(false);

  // 5. Wagmi Hooks (Thực thi Smart Contract)
  const { 
    data: releaseHash, 
    error: releaseError, 
    isPending: isReleasePending, 
    writeContract 
  } = useWriteContract();
  
  const { 
    isLoading: isReleaseConfirming, 
    isSuccess: isReleaseConfirmed 
  } = useWaitForTransactionReceipt({ hash: releaseHash });

  // Lắng nghe Tx Giải ngân thành công
  useEffect(() => {
    if (isReleaseConfirmed) {
      alert("🎉 Tiền đã được giải ngân thành công (Executed on-chain)!");
      // Đồng bộ trạng thái về DB (Tùy chọn)
      // api.post(`/escrow/${escrowId}/complete`);
    }
  }, [isReleaseConfirmed, escrowId]);

  // --- HÀM XỬ LÝ: KÝ PHÂN MẢNH (APPROVE & SIGN) ---
  const handleSign = async () => {
    if (hasSigned) return;
    setIsSigning(true);
    
    try {
      const mockPrivateKeyShare = "0xABC123..."; // Lấy từ IndexedDB trong thực tế
      // Worker tính toán ngầm
      const workerResult = await generateSignatureShare(escrowId, mockPrivateKeyShare);
      // Gửi Socket có cơ chế Optimistic UI
      await submitSignature(mockUserAddress, workerResult.signatureShare);
    } catch (error) {
      console.error("Lỗi khi ký:", error);
      alert(`Ký thất bại: ${error.message}`);
    } finally {
      setIsSigning(false);
    }
  };

  // --- HÀM XỬ LÝ: GIẢI NGÂN (EXECUTE RELEASE) ---
  const handleExecuteRelease = async () => {
    setIsFetchingSignature(true);
    try {
      // 1. Lấy chữ ký tổng hợp (Schnorr) và địa chỉ Vault từ Relayer
      const res = await api.get(`/escrow/${escrowId}/signature`);
      const { rAddr, z, e, msgHash, vaultContractAddress } = res.data; 

      const specificVaultAddress = vaultContractAddress || "0xDiaChiVaultCuaBan..."; 

      // 2. Bắn Giao dịch lên Smart Contract
      writeContract({
        address: specificVaultAddress, // Địa chỉ Két sắt cụ thể
        abi: vaultAbi,                 // ABI của Két sắt
        functionName: 'release',
        args: [rAddr, z, e, msgHash],
      });
    } catch (error) {
      console.error("Lỗi giải ngân:", error);
      alert(error.response ? `Backend Error: ${JSON.stringify(error.response.data)}` : `Lỗi Contract: ${error.message}`);
    } finally {
      setIsFetchingSignature(false);
    }
  };

  // --- RENDER LUỒNG RECOVERY ---
  if (isRecovering) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="animate-pulse text-xl text-slate-300">Recovering Session Data...</p>
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
          <span className="text-slate-400 text-sm">Role: <span className="text-white font-semibold capitalize">{role}</span></span>
          <button className="px-4 py-2 bg-slate-700 hover:bg-slate-600 transition-colors rounded-lg font-mono text-sm shadow-inner cursor-default border border-slate-600">
            {mockUserAddress}
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto mt-10 flex flex-col gap-8 px-6">
        
        {/* KHỐI 1: THÔNG TIN KÝ QUỸ */}
        <section className="bg-slate-800 p-8 rounded-2xl border border-slate-700 flex flex-col gap-4 shadow-xl">
          <div className="flex justify-between items-center border-b border-slate-700 pb-4">
            <h2 className="text-2xl font-bold tracking-wide">Escrow ID: #{escrowId || 'ESC-001'}</h2>
            {isReleaseConfirmed ? (
              <span className="bg-emerald-500/20 text-emerald-400 px-4 py-1.5 rounded-full text-sm font-bold border border-emerald-500/50 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> COMPLETED
              </span>
            ) : (
              <span className="bg-blue-500/20 text-blue-400 px-4 py-1.5 rounded-full text-sm font-bold border border-blue-500/50">
                ACTIVE
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <p className="text-slate-400 text-sm mb-1">Lock Amount</p>
              <p className="text-emerald-400 text-2xl font-bold font-mono">2.5 ETH</p>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between bg-slate-900/50 p-2 rounded border border-slate-700/50">
                <span className="text-slate-400 text-sm">Buyer:</span>
                <span className="text-slate-300 font-mono text-sm">0xBuyer...123</span>
              </div>
              <div className="flex justify-between bg-slate-900/50 p-2 rounded border border-slate-700/50">
                <span className="text-slate-400 text-sm">Seller:</span>
                <span className="text-slate-300 font-mono text-sm">0xSeller...456</span>
              </div>
            </div>
          </div>
        </section>

        {/* KHỐI 2: THANH TIẾN TRÌNH TSS 5-OF-7 */}
        <section className="flex flex-col gap-4">
          <div className="flex justify-between items-end">
            <h3 className="text-slate-300 font-medium text-lg">Consensus Progress</h3>
            <span className="text-sm font-mono text-slate-400 bg-slate-800 px-3 py-1 rounded-md border border-slate-700">
              {progress}/7 (Min 5 required)
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

        {/* KHỐI 4: CỤM NÚT HÀNH ĐỘNG */}
        <section className="flex gap-6 justify-center mt-4">
          <button 
            onClick={handleSign}
            disabled={hasSigned || isSigning || progress >= 7 || isReleaseConfirmed}
            className={`px-8 py-4 rounded-xl font-bold transition-all duration-300 w-56 flex items-center justify-center gap-2
              ${hasSigned || progress >= 7 || isReleaseConfirmed
                ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed' 
                : isSigning 
                  ? 'bg-blue-600/50 cursor-wait border border-blue-500/50' 
                  : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/25 border border-blue-500'}`}
          >
            {isSigning && <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>}
            {isSigning ? 'Computing...' : hasSigned ? 'Signed ✓' : 'Approve & Sign'}
          </button>

          <button 
            onClick={handleExecuteRelease}
            disabled={progress < 5 || isFetchingSignature || isReleasePending || isReleaseConfirming || isReleaseConfirmed}
            className={`px-8 py-4 rounded-xl font-bold transition-all duration-300 w-64 flex items-center justify-center gap-2
              ${progress >= 5 && !isReleaseConfirmed && !isFetchingSignature && !isReleasePending && !isReleaseConfirming
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_30px_rgba(16,185,129,0.4)] border border-emerald-500' 
                : isReleaseConfirmed
                  ? 'bg-emerald-900/50 text-emerald-500 border border-emerald-800 cursor-not-allowed'
                  : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'}`}
          >
            {(isFetchingSignature || isReleasePending || isReleaseConfirming) && 
              <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
            }
            {isFetchingSignature ? 'Fetching...' 
              : isReleasePending ? 'Confirming...' 
              : isReleaseConfirming ? 'Mining Tx...' 
              : isReleaseConfirmed ? 'Released ✓'
              : 'Execute Release'}
          </button>
        </section>

        {/* THÔNG BÁO LỖI ON-CHAIN (NẾU CÓ) */}
        {releaseError && (
          <div className="p-4 border border-red-500/30 bg-red-900/20 text-red-400 rounded-xl text-sm flex items-start gap-3">
            <span className="text-xl">⚠️</span>
            <div>
              <p className="font-bold mb-1">Transaction Failed</p>
              <p className="opacity-80 font-mono text-xs">{releaseError.shortMessage || releaseError.message}</p>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
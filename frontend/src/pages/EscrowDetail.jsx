import React, { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAtomValue } from 'jotai';

// Import các "Vũ khí hạng nặng" từ thư mục features
import { 
  escrowStatusAtom, 
  signatureProgressAtom, 
  systemLogsAtom, 
  signedNodesAtom 
} from '../features/escrow/escrowStore';
import { useTssWorker } from '../features/escrow/useTssWorker';
import { useEscrowSync } from '../features/escrow/useEscrowSync';
import { useSessionRecovery } from '../features/escrow/useSessionRecovery';

export default function EscrowDetail() {
  // 1. Lấy thông tin từ URL
  const { id: escrowId } = useParams();
  const [searchParams] = useSearchParams();
  const role = searchParams.get('role') || 'Unknown'; // VD: ?role=buyer
  const mockUserAddress = `${role}_0x123...`; // Giả lập địa chỉ ví theo role

  // 2. Khởi tạo các Custom Hooks (Logic chạy ngầm)
  const { isRecovering } = useSessionRecovery(escrowId);
  const { generateSignatureShare } = useTssWorker();
  const { submitSignature } = useEscrowSync(escrowId);

  // 3. Đăng ký nhận State từ Jotai để render UI
  const status = useAtomValue(escrowStatusAtom);
  const progress = useAtomValue(signatureProgressAtom);
  const logs = useAtomValue(systemLogsAtom);
  const signedNodes = useAtomValue(signedNodesAtom);

  // Tham chiếu để cuộn Terminal xuống dòng log mới nhất
  const logsEndRef = useRef(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // State quản lý nút bấm
  const [isSigning, setIsSigning] = useState(false);
  const hasSigned = signedNodes.includes(mockUserAddress);

  // Hàm xử lý khi bấm nút "Approve & Sign"
  const handleSign = async () => {
    if (hasSigned) return;
    setIsSigning(true);
    
    try {
      // BƯỚC 1: Gọi Web Worker tính toán phân mảnh chữ ký (Không block UI)
      const mockPrivateKeyShare = "0xABC123..."; 
      const workerResult = await generateSignatureShare(escrowId, mockPrivateKeyShare);
      
      // BƯỚC 2: Gửi chữ ký qua Socket (Có Optimistic UI)
      await submitSignature(mockUserAddress, workerResult.signatureShare);
      
    } catch (error) {
      console.error("Lỗi khi ký:", error);
      alert(`Ký thất bại: ${error.message}`);
    } finally {
      setIsSigning(false);
    }
  };

  // Nếu IndexedDB đang chạy khôi phục phiên, hiển thị Loading
  if (isRecovering) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <p className="animate-pulse text-xl">Recovering Session Data...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans pb-20">
      {/* NAVBAR */}
      <nav className="h-20 bg-slate-800 flex items-center justify-between px-8 shadow-md">
        <h1 className="text-2xl font-bold">TSS Escrow</h1>
        <div className="flex items-center gap-4">
          <span className="text-slate-400">Role: <span className="text-white font-semibold capitalize">{role}</span></span>
          <button className="px-4 py-2 bg-slate-700 rounded-lg cursor-default">
            {mockUserAddress}
          </button>
        </div>
      </nav>

      {/* MAIN CONTENT (Cấu trúc 4 Khối từ Figma) */}
      <main className="max-w-4xl mx-auto mt-10 flex flex-col gap-10">
        
        {/* KHỐI 1: Thông tin Ký quỹ */}
        <section className="bg-slate-800 p-8 rounded-2xl border border-slate-700 flex flex-col gap-3">
          <h2 className="text-2xl font-bold">Escrow ID: #{escrowId || 'ESC-001'}</h2>
          <p className="text-emerald-500 text-xl font-semibold">Amount: 2.5 ETH</p>
          <p className="text-slate-300">Buyer: 0xBuyer...123</p>
          <p className="text-slate-300">Seller: 0xSeller...456</p>
        </section>

        {/* KHỐI 2: Thanh Tiến Trình TSS (5-of-7) */}
        <section className="flex flex-col gap-4">
          <h3 className="text-slate-300 font-medium">Signatures: {progress}/7 (Minimum 5 required)</h3>
          <div className="flex gap-6">
            {[1, 2, 3, 4, 5, 6, 7].map((num) => {
              const isNodeSigned = num <= progress;
              return (
                <div 
                  key={num} 
                  className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-white transition-colors duration-500
                    ${isNodeSigned ? 'bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`}
                >
                  {num}
                </div>
              );
            })}
          </div>
        </section>

        {/* KHỐI 3: Cửa sổ Terminal Logs */}
        <section className="bg-black p-4 rounded-lg border border-slate-800 h-64 overflow-y-auto font-mono text-sm shadow-inner">
          <div className="flex flex-col gap-2">
            {logs.map((log, index) => (
              <div key={index} className={
                log.type === 'success' ? 'text-emerald-500' : 
                log.type === 'error' ? 'text-red-500' : 
                log.type === 'warning' ? 'text-yellow-500' : 'text-slate-400'
              }>
                <span className="opacity-50">[{log.time}]</span> {'>'} {log.message}
              </div>
            ))}
            <div ref={logsEndRef} /> {/* Điểm neo để auto-scroll */}
          </div>
        </section>

        {/* KHỐI 4: Cụm Nút Hành Động */}
        <section className="flex gap-6 justify-center">
          <button 
            onClick={handleSign}
            disabled={hasSigned || isSigning || progress >= 7}
            className={`px-8 py-3 rounded-lg font-bold transition-all
              ${hasSigned || progress >= 7 
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed' 
                : isSigning 
                  ? 'bg-blue-600/50 cursor-wait' 
                  : 'bg-blue-500 hover:bg-blue-600 text-white'}`}
          >
            {isSigning ? 'Computing TSS...' : hasSigned ? 'Signed ✓' : 'Approve & Sign'}
          </button>

          <button 
            disabled={progress < 5}
            className={`px-8 py-3 rounded-lg font-bold transition-all
              ${progress >= 5 
                ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-[0_0_20px_rgba(16,185,129,0.4)]' 
                : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'}`}
          >
            Execute Release
          </button>
        </section>

      </main>
    </div>
  );
}
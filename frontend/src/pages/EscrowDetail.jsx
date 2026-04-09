import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';
import { socket } from '../lib/socket'; 
// Chuẩn bị import api để chuẩn bị cho bước fetch data thật
import api from '../lib/api';

export default function EscrowDetail() {
  const { id } = useParams(); 
  const navigate = useNavigate();
  const { address } = useConnection(); 

  // --- MOCK DATA (Tạm thời giữ để UI render, sẽ thay bằng API ở bước sau) ---
  const mockEscrow = {
    id: id || "1",
    title: "Freelance Web Development",
    amount: "2.5",
    status: "AWAITING_SIGNATURES",
    buyer: "0x1234567890abcdef1234567890abcdef12345678", 
    seller: "0xabcdef1234567890abcdef1234567890abcdef12",
    mediator: "0x9999999999999999999999999999999999999999",
  };

  const [signatures, setSignatures] = useState({
    buyerSigned: false,
    sellerSigned: false,
    mediatorSigned: false,
  });

  const getUserRole = () => {
    if (!address) return "GUEST";
    if (address.toLowerCase() === mockEscrow.buyer.toLowerCase()) return "BUYER";
    if (address.toLowerCase() === mockEscrow.seller.toLowerCase()) return "SELLER";
    if (address.toLowerCase() === mockEscrow.mediator.toLowerCase()) return "MEDIATOR";
    return "GUEST";
  };

  const userRole = getUserRole();

  // ---------------------------------------------------------
  // LOGIC KẾT NỐI SOCKET.IO THỜI GIAN THỰC
  // ---------------------------------------------------------
  useEffect(() => {
    socket.connect();
    socket.emit('join_escrow_room', { escrowId: mockEscrow.id });

    socket.on('signature_updated', (data) => {
      console.log("New signature received via socket:", data);
      if (data.role === "BUYER") setSignatures(prev => ({ ...prev, buyerSigned: true }));
      if (data.role === "SELLER") setSignatures(prev => ({ ...prev, sellerSigned: true }));
      if (data.role === "MEDIATOR") setSignatures(prev => ({ ...prev, mediatorSigned: true }));
    });

    return () => {
      socket.off('signature_updated');
      socket.emit('leave_escrow_room', { escrowId: mockEscrow.id });
      socket.disconnect();
    };
  }, [mockEscrow.id]);

  const handleApprove = () => {
    // 1. Cập nhật UI ngay lập tức (Optimistic UI)
    if (userRole === "BUYER") setSignatures(prev => ({ ...prev, buyerSigned: true }));
    if (userRole === "SELLER") setSignatures(prev => ({ ...prev, sellerSigned: true }));
    if (userRole === "MEDIATOR") setSignatures(prev => ({ ...prev, mediatorSigned: true }));
    
    // 2. Phát tín hiệu (Emit) cho Backend
    socket.emit('sign_escrow', { 
      escrowId: mockEscrow.id, 
      role: userRole,
      signerAddress: address
    });

    alert("✅ TSS Signature generated and sent to Relayer!");
  };

  const totalSignatures = Object.values(signatures).filter(Boolean).length;

  return (
    <div className="max-w-4xl mx-auto p-6 mt-10">
      
      {/* Tiêu đề & Trạng thái */}
      <div className="flex justify-between items-center mb-8 border-b border-gray-800 pb-6">
        <div>
          <button 
            onClick={() => navigate('/')}
            className="text-gray-500 hover:text-white mb-4 text-sm flex items-center gap-2 transition-colors"
          >
            ← Back to Dashboard
          </button>
          <h1 className="text-4xl font-orbitron font-bold text-white mb-2">{mockEscrow.title}</h1>
          <p className="text-gray-400 font-mono">Escrow ID: #{mockEscrow.id}</p>
        </div>
        <div className="px-4 py-2 bg-yellow-900/40 border border-yellow-500/50 text-yellow-400 rounded-full font-bold text-sm uppercase tracking-wider">
          {mockEscrow.status.replace('_', ' ')}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Cột trái: Thông tin chi tiết */}
        <div className="md:col-span-2 space-y-6">
          <div className="bg-slate-800/50 backdrop-blur-md border border-white/10 rounded-2xl p-6 shadow-xl">
            <h2 className="text-xl font-orbitron text-accent mb-4">Transaction Details</h2>
            
            <div className="space-y-4 font-mono text-sm">
              <div className="flex justify-between border-b border-gray-700 pb-2">
                <span className="text-gray-400">Lock Amount:</span>
                <span className="text-white font-bold text-lg">{mockEscrow.amount} ETH</span>
              </div>
              <div className="flex justify-between border-b border-gray-700 pb-2">
                <span className="text-gray-400">Buyer (Depositor):</span>
                <span className="text-blue-300">{mockEscrow.buyer.slice(0,6)}...{mockEscrow.buyer.slice(-4)}</span>
              </div>
              <div className="flex justify-between border-b border-gray-700 pb-2">
                <span className="text-gray-400">Seller (Beneficiary):</span>
                <span className="text-blue-300">{mockEscrow.seller.slice(0,6)}...{mockEscrow.seller.slice(-4)}</span>
              </div>
              <div className="flex justify-between pb-2">
                <span className="text-gray-400">Mediator (TSS Node):</span>
                <span className="text-blue-300">{mockEscrow.mediator.slice(0,6)}...{mockEscrow.mediator.slice(-4)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Cột phải: Bảng điều khiển TSS */}
        <div className="bg-darkBg border border-primary/30 rounded-2xl p-6 shadow-lg shadow-primary/20 flex flex-col justify-between">
          <div>
            <h2 className="text-xl font-orbitron text-white mb-2">Consensus Panel</h2>
            <p className="text-xs text-gray-400 mb-6">Threshold Requirement: 2 of 3 signatures needed to release funds.</p>

            {/* Thanh tiến trình */}
            <div className="mb-6">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-300">Signatures Collected</span>
                <span className="text-accent font-bold">{totalSignatures} / 2</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                <div 
                  className={`h-full rounded-full transition-all duration-500 ${totalSignatures >= 2 ? 'bg-green-500' : 'bg-accent'}`}
                  style={{ width: `${Math.min((totalSignatures / 2) * 100, 100)}%` }}
                ></div>
              </div>
            </div>

            {/* Hiển thị trạng thái các bên */}
            <div className="space-y-3 mb-8 text-sm">
              <div className="flex justify-between items-center bg-black/20 p-3 rounded-lg border border-white/5">
                <span className="text-gray-400">Buyer</span>
                {signatures.buyerSigned ? <span className="text-green-400 font-bold">✅ Signed</span> : <span className="text-gray-500">⏳ Pending</span>}
              </div>
              <div className="flex justify-between items-center bg-black/20 p-3 rounded-lg border border-white/5">
                <span className="text-gray-400">Seller</span>
                {signatures.sellerSigned ? <span className="text-green-400 font-bold">✅ Signed</span> : <span className="text-gray-500">⏳ Pending</span>}
              </div>
              <div className="flex justify-between items-center bg-black/20 p-3 rounded-lg border border-white/5">
                <span className="text-gray-400">Mediator</span>
                {signatures.mediatorSigned ? <span className="text-green-400 font-bold">✅ Signed</span> : <span className="text-gray-500">⏳ Pending</span>}
              </div>
            </div>
          </div>

          {/* Nút hành động */}
          <div>
            {userRole === "GUEST" ? (
              <div className="text-center p-3 bg-red-900/20 text-red-400 rounded-lg text-sm border border-red-900/50">
                You are not a participant in this Escrow.
              </div>
            ) : totalSignatures >= 2 ? (
              <button className="w-full py-4 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg transition-colors shadow-lg shadow-green-500/30">
                Execute Release (On-chain)
              </button>
            ) : (
              <button 
                onClick={handleApprove}
                disabled={(userRole === "BUYER" && signatures.buyerSigned) || (userRole === "SELLER" && signatures.sellerSigned) || (userRole === "MEDIATOR" && signatures.mediatorSigned)}
                className="w-full py-4 bg-primary hover:bg-blue-600 text-white font-bold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/30"
              >
                Approve & Sign (TSS)
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
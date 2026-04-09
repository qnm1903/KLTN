import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection } from 'wagmi';
import api from '../lib/api';

export default function Home() {
  const navigate = useNavigate();
  const { address, isConnected } = useConnection();
  
  // State quản lý danh sách Escrow khi đã đăng nhập
  const [escrows, setEscrows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch danh sách Escrow từ Backend khi ví đã kết nối
  useEffect(() => {
    const fetchEscrows = async () => {
      if (!address) return;
      setIsLoading(true);
      try {
        // Gọi API lấy danh sách đơn hàng liên quan đến ví hiện tại
        const { data } = await api.get(`/escrows?address=${address}`);
        setEscrows(data.escrows || []);
      } catch (error) {
        console.error("Failed to fetch escrows:", error);
      } finally {
        setIsLoading(false);
      }
    };

    if (isConnected) {
      fetchEscrows();
    }
  }, [address, isConnected]);

  // TRẠNG THÁI 1: CHƯA KẾT NỐI VÍ (Hiển thị Landing Page)
  if (!isConnected) {
    return (
      <main className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-4 text-center relative overflow-hidden">
        {/* Hiệu ứng nền - Đã fix chuẩn Tailwind v4 */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-150 h-100 bg-primary/20 blur-[120px] rounded-full pointer-events-none"></div>

        <div className="z-10 max-w-3xl mt-20">
          <h1 className="font-orbitron text-5xl md:text-6xl font-extrabold mb-6 leading-tight">
            Decentralized <br/>
            {/* Gradient text - Đã fix chuẩn Tailwind v4 */}
            <span className="text-transparent bg-clip-text bg-linear-to-r from-blue-400 to-accent">
              Escrow System
            </span>
          </h1>
          <p className="text-lg md:text-xl text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
            Secure, transparent, and cost-efficient transactions powered by cutting-edge <strong className="text-gray-200">Threshold Signature Scheme (TSS)</strong>. No middlemen required.
          </p>
          <button 
            onClick={() => navigate('/create')}
            className="px-8 py-4 text-lg font-bold text-darkBg bg-accent rounded-xl hover:bg-yellow-500 hover:scale-105 transition-all duration-300 shadow-[0_0_20px_rgba(202,138,4,0.4)]"
          >
            Get Started
          </button>
        </div>
      </main>
    );
  }

  // TRẠNG THÁI 2: ĐÃ KẾT NỐI VÍ (Hiển thị Dashboard)
  return (
    <main className="max-w-6xl mx-auto px-6 py-12 mt-10">
      <div className="flex justify-between items-end mb-10 border-b border-gray-800 pb-6">
        <div>
          <h1 className="text-4xl font-orbitron font-bold text-white mb-2">My Escrows</h1>
          <p className="text-gray-400">Manage your active and completed transactions.</p>
        </div>
        <button 
          onClick={() => navigate('/create')}
          className="px-6 py-3 bg-primary hover:bg-blue-600 text-white font-bold rounded-lg transition-colors shadow-[0_0_15px_rgba(30,58,138,0.4)]"
        >
          + Create New Escrow
        </button>
      </div>

      {isLoading ? (
        <div className="text-center text-gray-400 py-20 animate-pulse">
          Loading your escrows...
        </div>
      ) : escrows.length === 0 ? (
        <div className="text-center py-20 bg-darkBg border border-dashed border-gray-700 rounded-2xl">
          <p className="text-gray-400 mb-4">You don't have any escrow transactions yet.</p>
          <button 
            onClick={() => navigate('/create')}
            className="text-accent hover:text-yellow-400 font-semibold underline underline-offset-4"
          >
            Create your first escrow
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {escrows.map((escrow) => (
            <div 
              key={escrow.id} 
              onClick={() => navigate(`/escrow/${escrow.id}`)}
              className="bg-[#1E293B]/50 border border-white/10 rounded-2xl p-6 cursor-pointer hover:border-primary/50 hover:shadow-[0_0_20px_rgba(30,58,138,0.2)] transition-all group"
            >
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-lg font-bold text-white group-hover:text-primary transition-colors line-clamp-1">{escrow.title}</h3>
                <span className="px-3 py-1 bg-blue-900/30 text-blue-400 text-xs font-bold rounded-full border border-blue-500/30">
                  {escrow.status}
                </span>
              </div>
              <div className="space-y-2 text-sm font-mono text-gray-400">
                <div className="flex justify-between">
                  <span>Amount:</span>
                  <span className="text-white font-semibold">{escrow.amount} ETH</span>
                </div>
                <div className="flex justify-between">
                  <span>Role:</span>
                  <span className="text-accent">
                    {escrow.buyerAddr?.toLowerCase() === address?.toLowerCase() ? 'BUYER' : 
                     escrow.sellerAddr?.toLowerCase() === address?.toLowerCase() ? 'SELLER' : 'MEDIATOR'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
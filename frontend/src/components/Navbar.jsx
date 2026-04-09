import React from 'react';
import { useConnect, useConnection } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { useSIWE } from '../hooks/useSIWE';

export default function Navbar() {
  const { connect } = useConnect();
  
  // Lấy address và isConnected từ useConnection (Wagmi v3)
  const { address, isConnected } = useConnection(); 
  
  // Lấy các hàm login, logout và trạng thái auth từ custom hook
  const { login, logout, auth } = useSIWE();

  const handleConnect = () => {
    // Kiểm tra xem trình duyệt có cài sẵn ví Web3 (MetaMask) chưa
    if (typeof window.ethereum === 'undefined') {
      alert("⚠️ MetaMask not found! \n\nPlease make sure you are opening this link in a browser with the MetaMask extension INSTALLED.");
      return;
    }
    // Gọi thẳng hàm connect (Wagmi v3)
    connect({ connector: injected() });
  };

  // Hàm rút gọn địa chỉ ví (Ví dụ: 0x1234...abcd)
  const truncateAddress = (addr) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <nav className="fixed top-0 left-0 w-full z-50 flex items-center justify-between px-8 py-4 bg-darkBg/80 backdrop-blur-md border-b border-white/10">
      
      {/* VÙNG TRÁI: Logo và Menu */}
      <div className="flex items-center gap-8">
        <div 
          className="text-2xl font-bold font-orbitron text-primary cursor-pointer tracking-wider"
          onClick={() => window.location.href = '/'}
        >
          Escrow<span className="text-accent">TSS</span>
        </div>
        
        {/* Nút truy cập nhanh tới trang lấy Key */}
        <a 
          href="/generate-key" 
          className="text-sm font-exo text-gray-400 hover:text-white transition-colors"
        >
          Key Generator
        </a>
      </div>
      
      {/* VÙNG PHẢI: Nút Connect Wallet & Auth */}
      <div className="flex gap-4 font-exo">
        {!isConnected ? (
          // Trạng thái 1: Chưa kết nối ví -> Hiển thị nút Connect Wallet
          <button 
            onClick={handleConnect}
            className="px-6 py-2.5 bg-primary text-white font-semibold rounded-lg hover:bg-blue-600 transition-all cursor-pointer shadow-[0_0_15px_rgba(30,58,138,0.4)]"
          >
            Connect Wallet
          </button>
        ) : !auth?.isAuthenticated ? (
          // Trạng thái 2: Đã kết nối ví nhưng chưa đăng nhập (SIWE) -> Yêu cầu Sign In
          <div className="flex items-center gap-4">
            <span className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-300 font-mono text-sm">
              {truncateAddress(address)}
            </span>
            <button 
              onClick={login}
              className="px-6 py-2.5 bg-accent text-darkBg font-bold rounded-lg hover:bg-yellow-500 transition-all cursor-pointer shadow-[0_0_15px_rgba(202,138,4,0.4)]"
            >
              Sign In (SIWE)
            </button>
          </div>
        ) : (
          // Trạng thái 3: Đã kết nối và xác thực thành công -> Hiện ví (màu xanh) và nút Sign Out
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2 px-4 py-2 bg-green-900/20 border border-green-500/30 rounded-lg text-green-400 font-mono text-sm">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              {truncateAddress(address)}
            </span>
            <button 
              onClick={logout}
              className="px-5 py-2.5 bg-red-900/40 border border-red-900/50 text-red-300 rounded-lg hover:bg-red-900 hover:text-white transition-colors cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
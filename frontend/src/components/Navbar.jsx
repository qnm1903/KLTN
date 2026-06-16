import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useConnect, useAccount } from 'wagmi';
import { injectedConnector } from '../lib/wagmi';
import { useSIWE } from '../hooks/useSIWE';
import api from '../lib/api';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveRoleFromEscrow(escrow, walletAddress) {
  const normalizedWalletAddress = normalizeAddress(walletAddress);
  if (!normalizedWalletAddress || !escrow) return null;

  if (normalizeAddress(escrow?.buyer?.walletAddress) === normalizedWalletAddress) {
    return 'buyer';
  }

  if (normalizeAddress(escrow?.seller?.walletAddress) === normalizedWalletAddress) {
    return 'seller';
  }

  const mediatorRow = (escrow?.escrowMediators || []).find(
    (row) => normalizeAddress(row?.mediator?.walletAddress) === normalizedWalletAddress,
  );

  if (mediatorRow?.slot) {
    return `mediator${mediatorRow.slot}`;
  }

  return null;
}

export default function Navbar() {
  const connect = useConnect();
  const { address, isConnected } = useAccount();
  const { login, logout, auth } = useSIWE();
  
  // // Lấy Role từ URL để hỗ trợ hiển thị lúc test 3 tab local
  // const urlParams = new URLSearchParams(window.location.search);
  // const role = urlParams.get('role');
  const location = useLocation();
  const [escrow, setEscrow] = useState(null);

  const escrowId = useMemo(() => {
    const match = location.pathname.match(/^\/escrow\/([^/]+)$/);
    return match?.[1] || null;
  }, [location.pathname]);

  useEffect(() => {
    let active = true;

    const loadEscrow = async () => {
      if (!escrowId) {
        setEscrow(null);
        return;
      }

      try {
        const { data } = await api.get(`/escrows/${escrowId}`);
        if (active) setEscrow(data || null);
      } catch {
        if (active) setEscrow(null);
      }
    };

    loadEscrow();

    return () => {
      active = false;
    };
  }, [escrowId]);

  const role = useMemo(() => {
    if (!escrowId) return null;
    return resolveRoleFromEscrow(escrow, address);
  }, [escrowId, escrow, address]);

  const handleConnect = () => {
    if (typeof window.ethereum === 'undefined') {
      alert("⚠️ MetaMask not found! \n\nPlease make sure you are opening this link in a browser with the MetaMask extension INSTALLED.");
      return;
    }
    connect.mutate({ connector: injectedConnector });
  };

  const truncateAddress = (addr) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <nav className="fixed top-0 left-0 w-full z-50 flex items-center justify-between px-8 h-20 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 shadow-md">
      
      {/* VÙNG TRÁI: Logo và Menu */}
      <div className="flex items-center gap-8">
        <div 
          className="text-2xl font-bold cursor-pointer tracking-wider bg-linear-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent"
          onClick={() => window.location.href = '/'}
        >
          TSS Escrow
        </div>
        
        <a
          href="/generate-key"
          className="text-sm font-medium text-slate-400 hover:text-white transition-colors"
        >
          Key Generator
        </a>
        <a
          href="/mediator"
          className="text-sm font-medium text-slate-400 hover:text-white transition-colors"
        >
          Mediator Pool
        </a>
      </div>
      
      {/* VÙNG PHẢI: Chế độ Test, Nút Connect & Auth */}
      <div className="flex items-center gap-6">
        
        {/* Hiển thị Role theo wallet + escrow data */}
        {role && (
          <span className="text-slate-400 text-sm hidden md:block">
            Role: <span className="text-white font-semibold capitalize">{role}</span>
          </span>
        )}

        {!isConnected ? (
          // Trạng thái 1: Chưa kết nối ví
          <button 
            onClick={handleConnect}
            className="px-6 py-2.5 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-500 transition-all cursor-pointer shadow-[0_0_15px_rgba(37,99,235,0.4)]"
          >
            Connect Wallet
          </button>
        ) : !auth?.isAuthenticated ? (
          // Trạng thái 2: Đã kết nối ví nhưng chưa đăng nhập (SIWE)
          <div className="flex items-center gap-4">
            <span className="px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-300 font-mono text-sm">
              {truncateAddress(address)}
            </span>
            <button 
              onClick={login}
              className="px-6 py-2.5 bg-yellow-500 text-slate-900 font-bold rounded-lg hover:bg-yellow-400 transition-all cursor-pointer shadow-[0_0_15px_rgba(234,179,8,0.4)]"
            >
              Sign In (SIWE)
            </button>
          </div>
        ) : (
          // Trạng thái 3: Đã xác thực thành công
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2 px-4 py-2.5 bg-emerald-900/20 border border-emerald-500/30 rounded-lg text-emerald-400 font-mono text-sm shadow-inner">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              {truncateAddress(address)}
            </span>
            <button 
              onClick={logout}
              className="px-5 py-2.5 bg-slate-800 border border-slate-700 text-slate-400 rounded-lg hover:bg-red-900/80 hover:text-red-300 hover:border-red-900 transition-colors cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
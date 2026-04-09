import React, { useState, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useConnection } from 'wagmi';
import { parseEther } from 'viem';
// [FIX]: Sử dụng custom api instance thay vì axios thuần để tự động đính kèm JWT
import api from '../lib/api'; 
// [FIX]: Import đúng factoryAbi từ abis.js
import { factoryAbi } from '../lib/abis'; 
import { ESCROW_CONTRACT_ADDRESS } from '../lib/constants'; // Đảm bảo bạn có hằng số này
import { savePrivKey, savePubKey, getPrivKey, getPubKey } from '../lib/storage';

export default function CreateEscrow() {
  const { address } = useConnection();
  
  // Trạng thái cho công tắc Manual/Auto
  const [setupMode, setSetupMode] = useState('manual'); 
  
  // Lưu trữ khóa TSS của Buyer hiển thị lên UI
  const [buyerTssKeys, setBuyerTssKeys] = useState({ privKey: '', pubKey: '' });

  // Form state giữ nguyên các biến thời hạn của bạn
  const [formData, setFormData] = useState({
    title: '', amount: '',
    sellerAddress: '', sellerPubKey: '',
    mediatorAddress: '', mediatorPubKey: '',
    confirmDays: '7', timeoutDays: '14'
  });

  const [isInitializing, setIsInitializing] = useState(false);

  // Khởi tạo/Lấy khóa cho Buyer tự động qua storage.js
  useEffect(() => {
    if (address) {
      const existingPrivKey = getPrivKey();
      const existingPubKey = getPubKey();
      
      if (!existingPrivKey || !existingPubKey) {
        // Tự sinh khóa nếu chưa có (Mock)
        const randomHex = Array.from({length: 40}, () => Math.floor(Math.random()*16).toString(16)).join('');
        const newPrivKey = `0x_priv_${randomHex.substring(0, 16)}`;
        const newPubKey = `0x_pub_${randomHex}`;
        
        savePrivKey(newPrivKey);
        savePubKey(newPubKey);
        setBuyerTssKeys({ privKey: newPrivKey, pubKey: newPubKey });
      } else {
        setBuyerTssKeys({ privKey: existingPrivKey, pubKey: existingPubKey });
      }
    }
  }, [address]);

  // Wagmi v3 Hooks
  const { data: hash, error: writeError, isPending, writeContract } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash });

  // Gọi API hoàn tất sau khi tx On-chain Confirmed
  useEffect(() => {
    const finalizeEscrow = async () => {
      if (isConfirmed && hash) {
        try {
          // [FIX]: Dùng api.post để tận dụng config axios (base URL, JWT)
          await api.post('/escrows/finalize', {
            transactionHash: hash,
            status: 'ACTIVE'
          });
          alert("🎉 Escrow fully created and active on-chain!");
          // Tùy chọn: Chuyển hướng người dùng về trang Dashboard sau khi tạo xong
          // window.location.href = '/'; 
        } catch (err) {
          console.error("Lỗi đồng bộ Backend sau khi tạo Escrow:", err);
        }
      }
    };
    finalizeEscrow();
  }, [isConfirmed, hash]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsInitializing(true);

    try {
      console.log("1. Sending 3 Public Keys to Backend for DKG Aggregation...");
      const escrowId = `ESC_${Date.now()}`;

      // BƯỚC A: Gọi API Init (Gửi kèm khóa pubKey của buyer vừa sinh ra)
      const initRes = await api.post('/escrow/init', {
        escrowId: escrowId,
        title: formData.title,
        buyerAddr: address,
        sellerAddr: formData.sellerAddress,
        mediatorAddr: formData.mediatorAddress,
        buyerPubKey: buyerTssKeys.pubKey, 
        sellerPubKey: formData.sellerPubKey,
        mediatorPubKey: formData.mediatorPubKey,
        amount: formData.amount
      });

      console.log("2. Received Aggregated Keys from Backend:", initRes.data);
      const pkAggCoords = initRes.data.pkAggCoords || [0n, 0n, 0n, 0n, 0n, 0n];

      console.log("3. Initiating Smart Contract Transaction...");

      // BƯỚC B: Giao dịch On-chain với các tham số thời hạn
      writeContract({
        address: ESCROW_CONTRACT_ADDRESS,
        abi: factoryAbi, // [FIX]: Dùng factoryAbi đã import
        functionName: 'createEscrow',
        args: [
          formData.sellerAddress,
          formData.mediatorAddress,
          pkAggCoords,
          parseEther(formData.amount),
          BigInt(formData.confirmDays),
          BigInt(formData.timeoutDays)
        ],
        value: parseEther(formData.amount),
      });

    } catch (err) {
      console.error("Init Error:", err);
      alert(err.response ? `Backend Error: ${JSON.stringify(err.response.data)}` : `Error: ${err.message}`);
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 mt-10">
      <div className="bg-[#1E293B]/50 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl">
        
        {/* HEADER & TOGGLE SWITCH */}
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="text-3xl font-orbitron font-bold text-accent mb-2">Initialize Escrow</h2>
            <p className="text-sm text-gray-400">Step 1: Distributed Key Generation</p>
          </div>
          <div className="flex bg-darkBg p-1 rounded-lg border border-gray-700">
            <button type="button" onClick={() => setSetupMode('manual')} className={`px-4 py-2 text-sm font-bold rounded-md transition-all ${setupMode === 'manual' ? 'bg-primary text-white shadow-lg' : 'text-gray-500'}`}>Manual</button>
            <button type="button" onClick={() => setSetupMode('auto')} className={`px-4 py-2 text-sm font-bold rounded-md transition-all flex items-center gap-2 ${setupMode === 'auto' ? 'bg-primary text-white shadow-lg' : 'text-gray-500'}`}>Auto-Join <span className="text-[10px] bg-accent text-black px-1.5 py-0.5 rounded uppercase">Soon</span></button>
          </div>
        </div>

        {/* THÔNG TIN KHÓA BUYER (Tự động) */}
        <div className="mb-6 p-4 bg-blue-900/20 rounded-xl border border-dashed border-blue-500/30">
          <p className="text-xs text-blue-300 mb-1">Your Auto-Generated TSS Identity (Buyer)</p>
          <div className="text-sm font-mono text-green-400 break-all">{buyerTssKeys.pubKey || "Generating..."}</div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Transaction Title</label>
              <input type="text" name="title" value={formData.title} onChange={handleChange} className="w-full bg-darkBg border border-gray-700 rounded-lg px-4 py-3 text-white focus:border-primary" required />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Amount (ETH)</label>
              <input type="number" name="amount" step="0.0001" value={formData.amount} onChange={handleChange} className="w-full bg-darkBg border border-gray-700 rounded-lg px-4 py-3 text-white focus:border-primary" required />
            </div>
          </div>

          <hr className="border-gray-700" />

          {setupMode === 'auto' ? (
             <div className="text-center p-8 border border-dashed border-gray-600 rounded-xl">
               <p className="text-accent">⏳ Auto-Join Mode is under construction.</p>
             </div>
          ) : (
            <>
              {/* Dữ liệu Seller */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Seller Address</label>
                  <input type="text" name="sellerAddress" value={formData.sellerAddress} onChange={handleChange} placeholder="0x..." className="w-full bg-darkBg border border-gray-700 rounded-lg px-4 py-3 text-white font-mono text-sm" required />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Seller Public Key</label>
                  <input type="text" name="sellerPubKey" value={formData.sellerPubKey} onChange={handleChange} placeholder="0x_pub_..." className="w-full bg-darkBg border border-gray-700 rounded-lg px-4 py-3 text-white font-mono text-sm" required />
                </div>
              </div>

              {/* Dữ liệu Mediator */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Mediator Address</label>
                  <input type="text" name="mediatorAddress" value={formData.mediatorAddress} onChange={handleChange} placeholder="0x..." className="w-full bg-darkBg border border-gray-700 rounded-lg px-4 py-3 text-white font-mono text-sm" required />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Mediator Public Key</label>
                  <input type="text" name="mediatorPubKey" value={formData.mediatorPubKey} onChange={handleChange} placeholder="0x_pub_..." className="w-full bg-darkBg border border-gray-700 rounded-lg px-4 py-3 text-white font-mono text-sm" required />
                </div>
              </div>
            </>
          )}

          <button type="submit" disabled={isInitializing || isPending || isConfirming || setupMode === 'auto'} className="w-full py-4 bg-primary hover:bg-blue-600 text-white font-bold rounded-lg transition-colors mt-6 disabled:opacity-50 disabled:cursor-not-allowed">
            {isInitializing ? 'Fetching DKG from Backend...' : isPending ? 'Confirming in Wallet...' : isConfirming ? 'Mining Transaction...' : 'Initialize & Fund Escrow'}
          </button>
        </form>

        {/* Thông báo */}
        {hash && <div className="mt-6 p-4 bg-blue-900/20 border border-blue-500/30 rounded-lg text-sm text-blue-300">Tx: {hash}</div>}
        {writeError && <div className="mt-4 p-4 bg-red-900/20 border border-red-500/30 rounded-lg text-sm text-red-400">❌ Error: {writeError.shortMessage}</div>}
      </div>
    </div>
  );
}
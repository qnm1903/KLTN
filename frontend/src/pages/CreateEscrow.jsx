import React, { useState, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useConnection } from 'wagmi';
import { parseEther } from 'viem';
import api from '../lib/api'; 
import { factoryAbi } from '../lib/abis'; 
import { ESCROW_CONTRACT_ADDRESS } from '../lib/constants';
import { savePrivKey, savePubKey, getPrivKey, getPubKey } from '../lib/storage';

export default function CreateEscrow() {
  const { address } = useConnection();
  
  // 1. Quản lý Khóa cá nhân/công khai của Buyer (tạo tự động)
  const [buyerTssKeys, setBuyerTssKeys] = useState({ privKey: '', pubKey: '' });

  // 2. State cho các thông tin cơ bản
  const [formData, setFormData] = useState({
    title: '', 
    amount: '',
    sellerAddress: '', 
    sellerPubKey: '',
    confirmDays: '7', 
    timeoutDays: '14'
  });

  // 3. State Mảng chứa đúng 5 Mediators (Bài toán 5-of-7)
  const [mediators, setMediators] = useState([
    { address: '', pubKey: '' },
    { address: '', pubKey: '' },
    { address: '', pubKey: '' },
    { address: '', pubKey: '' },
    { address: '', pubKey: '' }
  ]);

  const [isInitializing, setIsInitializing] = useState(false);

  // Sinh khóa DKG cho Buyer (Mock)
  useEffect(() => {
    if (address) {
      const existingPrivKey = getPrivKey();
      const existingPubKey = getPubKey();
      
      if (!existingPrivKey || !existingPubKey) {
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

  // Lắng nghe giao dịch thành công để báo cho Backend
  useEffect(() => {
    const finalizeEscrow = async () => {
      if (isConfirmed && hash) {
        try {
          await api.post('/escrow/finalize', { transactionHash: hash, status: 'ACTIVE' });
          alert("🎉 Escrow fully created and active on-chain!");
          window.location.href = '/'; 
        } catch (err) {
          console.error("Lỗi đồng bộ Backend:", err);
        }
      }
    };
    finalizeEscrow();
  }, [isConfirmed, hash]);

  // Handle Input thay đổi cho thông tin cơ bản
  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // Handle Input thay đổi cho mảng Mediators
  const handleMediatorChange = (index, field, value) => {
    const newMediators = [...mediators];
    newMediators[index][field] = value;
    setMediators(newMediators);
  };

  // XỬ LÝ SUBMIT (Giao tiếp Web2 -> Web3)
  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsInitializing(true);

    try {
      const escrowId = `ESC_${Date.now()}`;
      
      // BƯỚC 1: Lọc mảng để lấy list data gửi Backend
      const mediatorAddresses = mediators.map(m => m.address);
      const mediatorPubKeys = mediators.map(m => m.pubKey);

      // BƯỚC 2: Gọi API Init lấy pkAggCoords
      const initRes = await api.post('/escrow/init', {
        escrowId: escrowId,
        title: formData.title,
        amount: formData.amount,
        buyerAddr: address,
        sellerAddr: formData.sellerAddress,
        mediators: mediatorAddresses,      // Mảng 5 địa chỉ
        buyerPubKey: buyerTssKeys.pubKey, 
        sellerPubKey: formData.sellerPubKey,
        mediatorPubKeys: mediatorPubKeys   // Mảng 5 khóa công khai
      });

      const pkAggCoords = initRes.data.pkAggCoords || [0n, 0n, 0n, 0n, 0n, 0n];

      // BƯỚC 3: Kích hoạt Smart Contract
      writeContract({
        address: ESCROW_CONTRACT_ADDRESS,
        abi: factoryAbi,
        functionName: 'createEscrow',
        args: [
          formData.sellerAddress,
          mediatorAddresses, // Truyền nguyên mảng 5 địa chỉ vào Contract
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
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans py-10">
      <div className="max-w-3xl mx-auto">
        {/* CARD FORM THEO THIẾT KẾ FIGMA */}
        <div className="bg-slate-800 p-8 rounded-2xl border border-slate-700 shadow-2xl">
          
          <h2 className="text-3xl font-bold mb-8">Initialize 5-of-7 Escrow</h2>

          {/* HIỂN THỊ KHÓA BUYER */}
          <div className="mb-8 p-4 bg-slate-900 rounded-lg border border-slate-700">
            <p className="text-sm text-slate-400 mb-2">Your Auto-Generated TSS Identity (Buyer)</p>
            <p className="font-mono text-emerald-400 text-sm break-all">{buyerTssKeys.pubKey || "Generating..."}</p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-8">
            
            {/* KHỐI 1: THÔNG TIN CƠ BẢN */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Escrow Title / Description</label>
                <input type="text" name="title" value={formData.title} onChange={handleChange} 
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500" required />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Amount (ETH)</label>
                <input type="number" name="amount" step="0.0001" value={formData.amount} onChange={handleChange} 
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500" required />
              </div>
              <div className="flex flex-col gap-2 md:col-span-2">
                <label className="text-sm font-medium">Seller Address</label>
                <input type="text" name="sellerAddress" value={formData.sellerAddress} onChange={handleChange} placeholder="0x..." 
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 font-mono focus:outline-none focus:border-blue-500" required />
              </div>
              <div className="flex flex-col gap-2 md:col-span-2">
                <label className="text-sm font-medium">Seller Public Key</label>
                <input type="text" name="sellerPubKey" value={formData.sellerPubKey} onChange={handleChange} placeholder="0x_pub_..." 
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 font-mono focus:outline-none focus:border-blue-500" required />
              </div>
            </div>

            {/* KHỐI 2: KHU VỰC 5 MEDIATORS (NỀN ĐEN) */}
            <div className="bg-slate-900 p-6 rounded-xl border border-slate-700 flex flex-col gap-4">
              <h3 className="text-slate-400 text-sm font-medium uppercase tracking-wider mb-2">Mediators (5 required)</h3>
              
              {mediators.map((mediator, index) => (
                <div key={index} className="flex gap-4 items-start">
                  <div className="w-8 h-10 mt-1 flex items-center justify-center bg-slate-800 rounded-full text-slate-400 font-bold text-sm shrink-0">
                    {index + 1}
                  </div>
                  <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <input type="text" placeholder="Address (0x...)" value={mediator.address} 
                      onChange={(e) => handleMediatorChange(index, 'address', e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 font-mono text-sm focus:border-blue-500 w-full" required />
                    <input type="text" placeholder="Public Key (0x_pub_...)" value={mediator.pubKey} 
                      onChange={(e) => handleMediatorChange(index, 'pubKey', e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 font-mono text-sm focus:border-blue-500 w-full" required />
                  </div>
                </div>
              ))}
            </div>

            {/* NÚT BẤM */}
            <button type="submit" disabled={isInitializing || isPending || isConfirming} 
              className="w-full py-4 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors mt-2 disabled:opacity-50 disabled:cursor-not-allowed">
              {isInitializing ? 'Fetching DKG from Backend...' : isPending ? 'Confirming in Wallet...' : isConfirming ? 'Mining Transaction...' : 'Initialize Escrow'}
            </button>
          </form>

          {/* Logs & Errors */}
          {hash && <div className="mt-6 p-4 bg-blue-900/20 border border-blue-500/30 rounded-lg text-sm text-blue-300">Transaction Hash: {hash}</div>}
          {writeError && <div className="mt-4 p-4 border border-red-500/50 bg-red-900/20 text-red-400 rounded-lg text-sm">❌ Contract Error: {writeError.shortMessage || writeError.message}</div>}
        
        </div>
      </div>
    </div>
  );
}
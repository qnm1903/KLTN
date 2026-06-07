import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useConnection } from 'wagmi';
import api from '../lib/api'; 
import { getPubKey } from '../lib/storage';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export default function CreateEscrow() {
  const navigate = useNavigate();
  const { address } = useAccount(); 
  const { chainId } = useConnection();
  
  const [buyerPubKey, setBuyerPubKey] = useState('');
  const [formData, setFormData] = useState({ title: '', amount: '', sellerAddress: '' });
  const [isInitializing, setIsInitializing] = useState(false);
  

  const [status, setStatus] = useState(''); 

  useEffect(() => {
    if (address) setBuyerPubKey(getPubKey(address) || '');
  }, [address]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsInitializing(true);
    setStatus('Đang tạo bản nháp Escrow...'); 
    
    try {
      if (!address) throw new Error('Vui lòng kết nối ví.');
      if (!buyerPubKey) throw new Error('Thiếu Public Key.');

      const title = formData.title.trim();
      const amount = Number(formData.amount);
      const sellerAddress = normalizeAddress(formData.sellerAddress);

      // Bước 1: Tạo draft 
      const { data: draftEscrow } = await api.post('/escrows/draft', {
        title, description: title, amount, sellerAddress
      });

      // Bước 2: Gọi endpoint trigger VRF
      setStatus('Đang bốc 5 Trọng tài ngẫu nhiên qua VRF...');
      await api.post('/mediator/request-random', {
        escrowId: draftEscrow.id,
        buyerAddress: address,
        sellerAddress
      });

      // Bước 3: Chuyển hướng
      setStatus('Hoàn tất! Đang chuyển hướng...');
      // Lưu ý kiến trúc nhánh main: Sau khi bốc VRF xong thì chuyển qua GenerateKey để DKG
      navigate(`/generate-key?escrowId=${draftEscrow.id}`);
      
    } catch (err) {
      console.error("🔥 [CREATE ESCROW FAILED]:", err);
      let errorMsg = err.message;
      if (err.isAxiosError) {
        errorMsg = `[API Failed]: ${err.config?.url}\n[Chi tiết]: ${err.response?.data?.error || JSON.stringify(err.response?.data)}`;
      }
      alert("LỖI KHỞI TẠO:\n\n" + errorMsg);
    } finally {
      setIsInitializing(false);
      setStatus(''); // Dọn dẹp status khi xong hoặc lỗi
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans py-10">
      <div className="max-w-3xl mx-auto">
        <div className="bg-slate-800 p-8 rounded-2xl border border-slate-700 shadow-2xl">
          <h2 className="text-3xl font-bold mb-8">Initialize Escrow</h2>

          <div className="mb-8 p-4 bg-slate-900 rounded-lg border border-slate-700">
            <p className="text-sm text-slate-400 mb-2">Your TSS Public Key (Buyer)</p>
            <p className="font-mono text-emerald-400 text-sm break-all">{buyerPubKey || 'Missing. Generate at /generate-key first.'}</p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Escrow Title</label>
                <input type="text" name="title" value={formData.title} onChange={handleChange} 
                  placeholder="Ví dụ: Mua bán xe máy..."
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500" required />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Amount (ETH)</label>
                <input type="number" name="amount" step="0.0001" value={formData.amount} onChange={handleChange} 
                  placeholder="Ví dụ: 0.5"
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 focus:outline-none focus:border-blue-500" required />
              </div>
              <div className="flex flex-col gap-2 md:col-span-2">
                <label className="text-sm font-medium">Seller Address</label>
                <input type="text" name="sellerAddress" value={formData.sellerAddress} onChange={handleChange} placeholder="0x..." 
                  className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 font-mono focus:outline-none focus:border-blue-500" required />
              </div>
            </div>

            <button type="submit" disabled={isInitializing} 
              className="w-full py-4 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors mt-2 disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2">
              
              {/* Hiển thị status ra nút bấm nếu đang chạy, nếu không thì hiện chữ mặc định */}
              {isInitializing ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {status || 'Đang khởi tạo hệ thống...'}
                </>
              ) : (
                'Create Draft & Start Key Collection'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
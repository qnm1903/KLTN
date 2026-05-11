import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useConnection } from 'wagmi';
import api from '../lib/api'; 
import { ESCROW_CONTRACT_ADDRESS } from '../lib/wagmi';
import { getPubKey } from '../lib/storage';
import { getStoredAccessToken } from '../store/authStore';

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

  useEffect(() => {
    if (address) setBuyerPubKey(getPubKey(address) || '');
  }, [address]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
  e.preventDefault();
  setIsInitializing(true);

  try {
    // CLIENT-SIDE AUTHENTICATION GUARD
    if (!address) throw new Error('Vui lòng kết nối ví MetaMask.');
    if (!getStoredAccessToken()) throw new Error('Bạn chưa xác thực! Vui lòng nhấn nút "Sign In (SIWE)".');
    if (!buyerPubKey) throw new Error('Thiếu Public Key. Hãy vào trang /generate-key để tạo khóa.');

    // DATA SANITIZATION
    const title = formData.title.trim();
    const amount = Number(formData.amount);
    const sellerAddress = normalizeAddress(formData.sellerAddress);

    if (!title) throw new Error('Vui lòng nhập Tiêu đề Escrow.');
    if (!amount || amount <= 0) throw new Error('Số tiền phải lớn hơn 0.');
    if (!sellerAddress || sellerAddress.length < 40) throw new Error('Địa chỉ Seller không hợp lệ.');
    if (normalizeAddress(address) === sellerAddress) throw new Error('Địa chỉ Buyer và Seller phải khác nhau.');

    // Create draft escrow WITHOUT starting DKG / init — mediators are assigned later via VRF on dispute
    const { data: draftEscrow } = await api.post('/escrows/draft', {
      title,
      description: title,
      amount,
      sellerAddress
    });
    if (!draftEscrow?.id) throw new Error('Backend không trả về ID Draft.');

    // Do NOT call /escrow/init or /escrow/pubkey/submit here.
    // DKG/init should only start when participants (including mediators) are known.
    alert('✅ Escrow draft created. Mediators will be assigned by VRF when needed.');
    navigate(`/escrow/${draftEscrow.id}`);

  } catch (err) {
    console.error("🔥 [CREATE ESCROW FAILED]:", err);
    let errorMsg = err.message;
    if (err.isAxiosError) {
      errorMsg = `[API Failed]: ${err.config?.url}\n[Chi tiết]: ${err.response?.data?.error || JSON.stringify(err.response?.data)}`;
    }
    alert("LỖI KHỞI TẠO:\n\n" + errorMsg);
  } finally {
    setIsInitializing(false);
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
              className="w-full py-4 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors mt-2 disabled:opacity-50 disabled:cursor-not-allowed">
              {isInitializing ? 'Đang khởi tạo hệ thống...' : 'Create Draft & Start Key Collection'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
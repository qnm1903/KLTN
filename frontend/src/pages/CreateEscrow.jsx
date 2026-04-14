import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, useChainId } from 'wagmi';
import api from '../lib/api'; 
import { ESCROW_CONTRACT_ADDRESS } from '../lib/wagmi';
import { getPubKey } from '../lib/storage';

const MEDIATOR_COUNT = 5;

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

export default function CreateEscrow() {
  const navigate = useNavigate();
  const { address } = useConnection();
  const chainId = useChainId();
  
  // 1. Quản lý Khóa cá nhân/công khai của Buyer (tạo tự động)
  const [buyerPubKey, setBuyerPubKey] = useState('');

  // 2. State cho các thông tin cơ bản
  const [formData, setFormData] = useState({
    title: '', 
    amount: '',
    sellerAddress: ''
  });

  // 3. State Mảng chứa đúng 5 Mediators (Bài toán 5-of-7)
  const [mediators, setMediators] = useState(
    Array.from({ length: MEDIATOR_COUNT }, () => ({ address: '' }))
  );

  const [isInitializing, setIsInitializing] = useState(false);

  // Đọc pubkey đã derive từ wallet signature
  useEffect(() => {
    if (address) {
      setBuyerPubKey(getPubKey(address) || '');
    }
  }, [address]);

  // Handle Input thay đổi cho thông tin cơ bản
  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // Handle Input thay đổi cho mảng Mediators
  const handleMediatorChange = (index, value) => {
    const newMediators = [...mediators];
    newMediators[index].address = value;
    setMediators(newMediators);
  };

  const validateMediatorCommittee = (buyerAddress, sellerAddress, mediatorAddresses) => {
    if (mediatorAddresses.length !== MEDIATOR_COUNT) {
      throw new Error(`Exactly ${MEDIATOR_COUNT} mediator addresses are required.`);
    }

    if (new Set(mediatorAddresses).size !== mediatorAddresses.length) {
      throw new Error('Mediator addresses must be unique.');
    }

    if (buyerAddress === sellerAddress) {
      throw new Error('Buyer and seller addresses must be different.');
    }

    if (mediatorAddresses.some((mediatorAddress) => mediatorAddress === buyerAddress || mediatorAddress === sellerAddress)) {
      throw new Error('Mediator addresses must be different from buyer and seller.');
    }
  };

  // XỬ LÝ SUBMIT (Luồng incremental: draft -> init -> submit buyer pubkey)
  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsInitializing(true);

    try {
      if (!address) {
        throw new Error('Please connect your wallet first.');
      }

      if (!buyerPubKey) {
        throw new Error('Buyer public key is missing. Please generate key first at /generate-key.');
      }

      const normalizedBuyerAddress = normalizeAddress(address);
      const normalizedSellerAddress = normalizeAddress(formData.sellerAddress);
      const normalizedMediatorAddresses = mediators
        .map((medi) => normalizeAddress(medi.address))
        .filter(Boolean);

      validateMediatorCommittee(normalizedBuyerAddress, normalizedSellerAddress, normalizedMediatorAddresses);

      const { data: draftEscrow } = await api.post('/escrows/draft', {
        title: formData.title,
        description: formData.title,
        amount: Number(formData.amount),
        sellerAddress: normalizedSellerAddress,
        mediatorAddresses: normalizedMediatorAddresses
      });

      if (!draftEscrow?.id) {
        throw new Error('Escrow draft creation failed.');
      }

      await api.post('/escrow/init', {
        escrowId: draftEscrow.id,
        chainId: String(chainId || Number(import.meta.env.VITE_CHAIN_ID || 11155111)),
        contractAddress: ESCROW_CONTRACT_ADDRESS
      });

      await api.post('/escrow/pubkey/submit', {
        escrowId: draftEscrow.id,
        role: 'buyer',
        pubKey: buyerPubKey
      });

      alert('Escrow draft initialized. Your buyer public key has been submitted.');
      navigate(`/escrow/${draftEscrow.id}`);

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
            <p className="text-sm text-slate-400 mb-2">Your Wallet-Derived Public Key (Buyer)</p>
            <p className="font-mono text-emerald-400 text-sm break-all">{buyerPubKey || 'Missing. Generate at /generate-key first.'}</p>
            {!buyerPubKey && (
              <a
                href="/generate-key"
                className="inline-flex mt-3 text-sm text-amber-300 hover:text-amber-200 underline underline-offset-4"
              >
                Generate buyer key now
              </a>
            )}
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
            </div>

            {/* KHỐI 2: KHU VỰC 5 MEDIATORS (NỀN ĐEN) */}
            <div className="bg-slate-900 p-6 rounded-xl border border-slate-700 flex flex-col gap-4">
              <h3 className="text-slate-400 text-sm font-medium uppercase tracking-wider mb-2">Mediators (5 required)</h3>
              
              {mediators.map((mediator, index) => (
                <div key={index} className="flex gap-4 items-start">
                  <div className="w-8 h-10 mt-1 flex items-center justify-center bg-slate-800 rounded-full text-slate-400 font-bold text-sm shrink-0">
                    {index + 1}
                  </div>
                  <div className="flex-1 grid grid-cols-1 gap-4">
                    <input type="text" placeholder="Address (0x...)" value={mediator.address} 
                      onChange={(e) => handleMediatorChange(index, e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 font-mono text-sm focus:border-blue-500 w-full" required />
                  </div>
                </div>
              ))}
            </div>

            {/* NÚT BẤM */}
            <button type="submit" disabled={isInitializing || !buyerPubKey} 
              className="w-full py-4 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors mt-2 disabled:opacity-50 disabled:cursor-not-allowed">
              {isInitializing ? 'Initializing Incremental DKG...' : !buyerPubKey ? 'Generate Buyer Key First' : 'Create Draft & Start Key Collection'}
            </button>
          </form>
        
        </div>
      </div>
    </div>
  );
}
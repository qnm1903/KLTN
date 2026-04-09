import React, { useState } from 'react';
import { savePrivKey } from '../lib/storage'; // Import helper lưu trữ bạn đã tạo
// Tạm thời comment hàm sinh khóa thật cho đến khi nhánh main cung cấp file
// import { generateTSSKeyPair } from '../lib/crypto/ecc'; 

export default function GenerateKey() {
  const [keys, setKeys] = useState({ pubKey: '', privKey: '' });

  const handleGenerate = () => {
    // Khi có file crypto từ nhánh main, bạn mở comment dòng dưới và xóa phần mock
    // const { privKey, pubKey } = generateTSSKeyPair();
    
    // --- MOCK DATA (Giả lập sinh khóa) ---
    const randomHex = Array.from({length: 40}, () => Math.floor(Math.random()*16).toString(16)).join('');
    const mockPrivKey = `0x_priv_${randomHex.substring(0, 16)}`;
    const mockPubKey = `0x_pub_${randomHex}`;
    // -------------------------------------

    // Lưu Private Key vào LocalStorage (Đã xử lý 2 mode qua lib/storage.js)
    savePrivKey(mockPrivKey);
    
    // Hiển thị Public Key ra màn hình
    setKeys({ pubKey: mockPubKey, privKey: mockPrivKey });
  };

  const copyToClipboard = () => {
    if (!keys.pubKey) return;
    navigator.clipboard.writeText(keys.pubKey);
    alert("✅ Public Key copied to clipboard! Send this to the Buyer.");
  };

  return (
    <div className="max-w-2xl mx-auto p-6 mt-20">
      <div className="bg-[#1E293B]/50 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
        <h2 className="text-3xl font-orbitron font-bold mb-4 text-accent">TSS Key Generator</h2>
        <p className="text-gray-400 mb-8">
          Are you a Seller or Mediator? Generate your Threshold Signature Scheme keys here. 
          Keep your Private Key secure and send the Public Key to the Buyer.
        </p>

        <button 
          onClick={handleGenerate}
          className="px-8 py-4 bg-primary hover:bg-blue-600 text-white font-bold rounded-lg transition-colors shadow-[0_0_15px_rgba(30,58,138,0.4)] mb-8"
        >
          Generate My TSS Keys
        </button>

        {keys.pubKey && (
          <div className="text-left bg-darkBg border border-gray-700 rounded-xl p-6 space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Your Public Key (Share this)</label>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  readOnly 
                  value={keys.pubKey} 
                  className="w-full bg-black/30 border border-gray-600 rounded-lg px-4 py-2 text-green-400 font-mono text-sm"
                />
                <button 
                  onClick={copyToClipboard}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white font-semibold transition-colors"
                >
                  Copy
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Your Private Key (DO NOT SHARE)</label>
              <input 
                type="text" 
                readOnly 
                value={keys.privKey} 
                className="w-full bg-black/30 border border-red-900/50 rounded-lg px-4 py-2 text-red-400 font-mono text-sm"
              />
              <p className="text-xs text-red-500 mt-2">
                * This key is automatically saved securely in your browser's local storage.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
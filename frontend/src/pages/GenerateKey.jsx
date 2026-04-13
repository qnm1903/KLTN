import React, { useState } from 'react';
import { useConnection, useSignMessage } from 'wagmi';
import { hashMessage, recoverPublicKey } from 'viem';
import { savePubKey } from '../lib/storage';

export default function GenerateKey() {
  const { address } = useConnection();
  const signMessage = useSignMessage();
  const [keys, setKeys] = useState({ pubKey: '', proofMessage: '' });

  const handleGenerate = async () => {
    if (!address) {
      alert('Please connect your wallet first.');
      return;
    }

    try {
      const message = `Escrow TSS key registration\nAddress: ${address}\nTimestamp: ${Date.now()}`;
      const signature = await signMessage.mutateAsync({ message });
      const pubKey = await recoverPublicKey({
        hash: hashMessage(message),
        signature
      });

      savePubKey(pubKey, address);
      setKeys({ pubKey, proofMessage: message });
      alert('Public key derived from your wallet signature and saved locally.');
    } catch (error) {
      console.error('Generate pubkey error:', error);
      alert(error?.message || 'Failed to generate public key from wallet signature.');
    }
  };

  const copyToClipboard = () => {
    if (!keys.pubKey) return;
    navigator.clipboard.writeText(keys.pubKey);
    alert("✅ Public Key copied to clipboard! Send this to the Buyer.");
  };

  return (
    <div className="max-w-2xl mx-auto p-6 mt-20">
      <div className="bg-surface/50 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
        <h2 className="text-3xl font-orbitron font-bold mb-4 text-accent">TSS Key Generator</h2>
        <p className="text-gray-400 mb-8">
          Derive your secp256k1 public key from wallet signature and submit it to incremental DKG flow.
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
              <label className="block text-sm text-gray-400 mb-1">Proof Message (for reproducibility)</label>
              <input 
                type="text" 
                readOnly 
                value={keys.proofMessage} 
                className="w-full bg-black/30 border border-blue-900/50 rounded-lg px-4 py-2 text-blue-300 font-mono text-sm"
              />
              <p className="text-xs text-blue-400 mt-2">
                * Private key stays in your wallet. Frontend only stores recovered public key.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
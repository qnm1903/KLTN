import React, { useState } from 'react';
import { useConnection } from 'wagmi';
import * as elliptic from 'elliptic';
import { savePubKey, saveEncryptedPrivKey } from '../lib/storage';

const ec = new elliptic.ec('secp256k1');

export default function GenerateKey() {
  const { address } = useConnection();
  const [keys, setKeys] = useState({ pubKey: '', proofMessage: '' });
  const [passphrase, setPassphrase] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!address) {
      alert('Please connect your wallet first.');
      return;
    }

    if (!passphrase.trim()) {
      alert('Please set a passphrase to encrypt your private share.');
      return;
    }

    try {
      setIsGenerating(true);

      const keyPair = ec.genKeyPair();
      const privateKeyHex = keyPair.getPrivate('hex').padStart(64, '0');
      const pubPoint = keyPair.getPublic();
      const pubKey = `0x04${pubPoint.getX().toString('hex').padStart(64, '0')}${pubPoint.getY().toString('hex').padStart(64, '0')}`;

      await saveEncryptedPrivKey(`0x${privateKeyHex}`, address, passphrase.trim());
      savePubKey(pubKey, address);

      setKeys({
        pubKey,
        proofMessage: `Generated locally for ${address} at ${new Date().toISOString()}`
      });
      alert('TSS keypair generated. Private share encrypted and ready for Round 2.');
    } catch (error) {
      console.error('Generate pubkey error:', error);
      alert(error?.message || 'Failed to generate TSS keypair.');
    } finally {
      setIsGenerating(false);
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
          Generate a local secp256k1 TSS keypair. The private share is encrypted with your passphrase and can be reused for Round 2.
        </p>

        <div className="text-left bg-darkBg border border-gray-700 rounded-xl p-6 space-y-4 mb-8">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Passphrase</label>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Set a passphrase to encrypt your private share"
              className="w-full bg-black/30 border border-gray-600 rounded-lg px-4 py-2 text-amber-200 font-mono text-sm"
            />
          </div>
        </div>

        <button 
          onClick={handleGenerate}
          disabled={isGenerating}
          className="px-8 py-4 bg-primary hover:bg-blue-600 text-white font-bold rounded-lg transition-colors shadow-[0_0_15px_rgba(30,58,138,0.4)] mb-8"
        >
          {isGenerating ? 'Generating...' : 'Generate My TSS Keys'}
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
                * Private share is encrypted locally for Round 2. Public key is what you submit to the flow.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
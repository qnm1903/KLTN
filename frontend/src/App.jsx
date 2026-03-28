import { useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSignMessage } from 'wagmi';
import { injected } from 'wagmi/connectors';
import api from './lib/api';

function App() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage(); 
  
  const [isSigningIn, setIsSigningIn] = useState(false);

  // Sign-In with Ethereum (SIWE) Flow
  const handleSignIn = async () => {
    try {
      setIsSigningIn(true);
      
      // STEP 1: Request Nonce from Backend
      console.log("1. Requesting Nonce from Backend...");
      const nonceRes = await api.get(`/auth/nonce?address=${address}`);
      const nonce = nonceRes.data.nonce || nonceRes.data; 
      
      // STEP 2: Create the message to be signed (must match backend verification)
      const message = `Sign this message to authenticate with Escrow TSS DApp.\n\nNonce: ${nonce}`;
      
      // STEP 3: Prompt MetaMask for user signature
      console.log("2. Waiting for user signature via MetaMask...");
      const signature = await signMessageAsync({ message });
      
      // STEP 4: Send signature to Backend for verification
      console.log("3. Sending signature to Backend for verification...");
      const verifyRes = await api.post('/auth/verify', {
        address,
        signature,
      });

      console.log("Sign-in successful!", verifyRes.data);
      alert("Backend authentication successful! You can check the browser console.");

    } catch (error) {
      console.error("Sign-in process failed:", error);
      
      if (error.response) {
        alert(`Backend Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      } else {
        alert(`Error: ${error.message}`);
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-darkBg text-white font-exo selection:bg-primary selection:text-white">
      
      {/* NAVBAR */}
      <nav className="fixed top-0 w-full z-50 flex justify-between items-center px-8 py-4 border-b border-white/10 bg-darkBg/80 backdrop-blur-md">
        <div className="font-orbitron text-2xl font-bold tracking-wider cursor-pointer">
          <span className="text-white">Escrow</span>
          <span className="text-accent">TSS</span>
        </div>

        <div>
          {!isConnected ? (
            <button 
              onClick={() => connect({ connector: injected() })}
              className="px-6 py-2.5 rounded-lg border border-primary text-blue-400 hover:bg-primary hover:text-white transition-all duration-300 font-semibold shadow-[0_0_15px_rgba(30,58,138,0.3)] hover:shadow-[0_0_20px_rgba(30,58,138,0.6)]"
            >
              Connect Wallet
            </button>
          ) : (
            <div className="flex items-center gap-4">
              {/* SIGN IN BUTTON */}
              <button 
                onClick={handleSignIn}
                disabled={isSigningIn}
                className="px-4 py-2 rounded-lg bg-primary text-white font-semibold hover:bg-blue-600 transition-colors disabled:opacity-50"
              >
                {isSigningIn ? "Signing in..." : "Sign In to Backend"}
              </button>

              <span className="text-sm bg-white/5 px-4 py-2 rounded-lg border border-white/10 font-mono text-gray-300">
                {address.substring(0, 6)}...{address.substring(address.length - 4)}
              </span>
              
              <button 
                onClick={() => disconnect()}
                className="px-4 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* HERO SECTION */}
      <main className="flex flex-col items-center justify-center min-h-screen px-4 pt-20 text-center relative overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[37.5rem] h-[25rem] bg-primary/20 blur-[120px] rounded-full pointer-events-none"></div>

        <div className="z-10 max-w-3xl">
          <h1 className="font-orbitron text-5xl md:text-6xl font-extrabold mb-6 leading-tight">
            Decentralized <br/>
            <span className="text-transparent bg-clip-text bg-linear-to-r from-blue-400 to-accent">
              Escrow System
            </span>
          </h1>
          <p className="text-lg md:text-xl text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
            Secure, transparent, and cost-efficient transactions powered by cutting-edge <strong className="text-gray-200">Threshold Signature Scheme (TSS)</strong>. No middlemen required.
          </p>
          <button className="px-8 py-4 text-lg font-bold text-darkBg bg-accent rounded-xl hover:bg-yellow-500 hover:scale-105 transition-all duration-300 shadow-[0_0_20px_rgba(202,138,4,0.4)]">
            Create New Escrow
          </button>
        </div>
      </main>
    </div>
  );
}

export default App;
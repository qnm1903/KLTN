import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';  
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateEscrow from './pages/CreateEscrow';
import EscrowDetail from './pages/EscrowDetail';
import GenerateKey from './pages/GenerateKey';
import DisputeList from './pages/DisputeList';
import DisputeDetail from './pages/DisputeDetail';
import MediatorPool from './pages/MediatorPool';

function App() {

  useEffect(() => {
    // Hàm cleanup này sẽ tự động chạy khi component unmount (hoặc HMR/StrictMode)
    return () => {
      try {
        const w = window?.ethereum;
        if (w && typeof w.removeAllListeners === 'function') {
          // Gỡ bỏ các event phổ biến nhất của Provider
          try { w.removeAllListeners('accountsChanged'); } catch (e) {}
          try { w.removeAllListeners('chainChanged'); } catch (e) {}
          try { w.removeAllListeners('disconnect'); } catch (e) {}
          
          // Gỡ bỏ toàn bộ các listener ẩn khác
          try { w.removeAllListeners(); } catch (e) {}
        }
      } catch (e) {
        console.warn('[App Cleanup] Không thể dọn dẹp MetaMask provider listeners:', e);
      }
    };
  }, []);
  
  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans selection:bg-blue-500 selection:text-white">
      <BrowserRouter>
        <Navbar />
        {/* Khởi tạo hệ thống Toast ở root */}
        <ToastContainer position="top-right" autoClose={5000} theme="dark" />
        
        <div className="pt-28 pb-10">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/create" element={<CreateEscrow />} />
            <Route path="/escrow/:id" element={<EscrowDetail />} />
            <Route path="/generate-key" element={<GenerateKey />} />
            
            {/* Dispute flow */}
            <Route path="/disputes" element={<DisputeList />} />
            <Route path="/disputes/:id" element={<DisputeDetail />} />

            {/* Mediator pool registration */}
            <Route path="/mediator" element={<MediatorPool />} />
          </Routes>
        </div>
      </BrowserRouter>
    </div>
  );
}

export default App;
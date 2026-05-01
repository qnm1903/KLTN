import React from 'react';
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

function App() {
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
            
            {/* Thêm 2 Route cho luồng Dispute */}
            <Route path="/disputes" element={<DisputeList />} />
            <Route path="/disputes/:id" element={<DisputeDetail />} />
          </Routes>
        </div>
      </BrowserRouter>
    </div>
  );
}

export default App;
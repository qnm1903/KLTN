import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateEscrow from './pages/CreateEscrow';
import EscrowDetail from './pages/EscrowDetail';
import GenerateKey from './pages/GenerateKey';

function App() {
  return (
    // Dùng màu nền slate-900 và selection chuẩn Tailwind v4
    <div className="min-h-screen bg-slate-900 text-slate-50 font-sans selection:bg-blue-500 selection:text-white">
      <BrowserRouter>
        {/* Đưa Navbar vào trong BrowserRouter */}
        <Navbar />
        
        {/* [FIX]: pt-28 (112px) để không bị Navbar (h-20) che khuất nội dung */}
        <div className="pt-28 pb-10">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/create" element={<CreateEscrow />} />
            <Route path="/escrow/:id" element={<EscrowDetail />} />
            <Route path="/generate-key" element={<GenerateKey />} />
          </Routes>
        </div>
      </BrowserRouter>
    </div>
  );
}

export default App;
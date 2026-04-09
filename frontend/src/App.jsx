import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateEscrow from './pages/CreateEscrow';
import EscrowDetail from './pages/EscrowDetail';
import GenerateKey from './pages/GenerateKey'; // 1. IMPORT TRANG MỚI

function App() {
  return (
    <div className="min-h-screen bg-darkBg text-white font-exo selection:bg-primary selection:text-white">
      <Navbar />
      
      <div className="pt-20">
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/create" element={<CreateEscrow />} />
            <Route path="/escrow/:id" element={<EscrowDetail />} />
            
            {/* 2. THÊM ROUTE CHO TRANG LẤY KHÓA */}
            <Route path="/generate-key" element={<GenerateKey />} />
            
          </Routes>
        </BrowserRouter>
      </div>
    </div>
  );
}

export default App;
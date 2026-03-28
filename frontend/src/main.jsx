import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// 1. Import các thư viện Provider của Web3
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// 2. Import file cấu hình wagmi bạn đã tạo ở thư mục lib
import { wagmiConfig } from './lib/wagmi'

// 3. Khởi tạo Query Client (bắt buộc đi kèm với Wagmi v3)
const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* Bọc toàn bộ App bằng Wagmi và QueryClient */}
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
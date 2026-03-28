import { useConnect, useConnection } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { useSIWE } from '../hooks/useSIWE';

export default function Navbar() {
  const connect = useConnect();
  const { address, isConnected } = useConnection();
  const { login, logout, auth } = useSIWE();

  const handleConnect = () => {
    if (typeof window.ethereum === 'undefined') {
      alert("⚠️ Không tìm thấy MetaMask! \n\nVui lòng đảm bảo bạn đang mở link này trên trình duyệt ĐÃ CÀI ĐẶT tiện ích MetaMask.");
      return;
    }
    connect.mutateAsync({ connector: injected() });
  };

  const truncateAddress = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    // Thay bg-[var(--color-darkBg)] thành bg-darkBg
    <nav className="flex items-center justify-between p-4 bg-darkBg border-b border-gray-800">
      {/* Thay text-[var(--color-primary)] và text-[var(--color-accent)] */}
      <div className="text-2xl font-bold font-orbitron text-primary">
        Escrow<span className="text-accent">TSS</span>
      </div>
      
      <div className="flex gap-4">
        {!isConnected ? (
          <button 
            onClick={handleConnect}
            // Thay bg-[var(--color-primary)] thành bg-primary
            className="px-6 py-2 bg-primary text-white font-exo rounded hover:bg-blue-700 transition cursor-pointer shadow-lg shadow-blue-900/50"
          >
            Kết nối Ví
          </button>
        ) : !auth?.isAuthenticated ? (
          <button 
            onClick={login}
            // Thay bg-[var(--color-accent)] thành bg-accent
            className="px-6 py-2 bg-accent text-black font-bold font-exo rounded hover:bg-yellow-500 transition cursor-pointer"
          >
            Ký Đăng Nhập
          </button>
        ) : (
          <div className="flex items-center gap-4">
            <span className="px-4 py-2 bg-gray-800 border border-gray-600 rounded text-gray-300 font-exo">
              {truncateAddress(address)}
            </span>
            <button 
              onClick={logout}
              className="px-4 py-2 bg-red-900/80 text-white rounded hover:bg-red-700 transition cursor-pointer"
            >
              Thoát
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
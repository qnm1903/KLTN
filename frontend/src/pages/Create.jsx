import { useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { factoryAbi } from '../lib/abis';
import { ESCROW_CONTRACT_ADDRESS } from '../lib/wagmi';

export default function Create() {
  const [formData, setFormData] = useState({
    seller: '',
    mediator: '0x0000000000000000000000000000000000000000', // Sẽ thay bằng địa chỉ ví của Mediator sau
    amount: '',
    confirmDays: '3',
    timeoutDays: '7',
  });

  // Hooks của Wagmi v3 để gọi hàm Ghi (Write) lên Smart Contract
  const { data: hash, writeContract, isPending, error } = useWriteContract();
  
  // Hook chờ Blockchain xác nhận giao dịch
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash });

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Lưu ý: pkAggCoords là Khóa công khai tổng hợp từ thuật toán TSS.
    // Tạm thời ta dùng mảng 0 để test luồng gọi Smart Contract. Ở Phase sau sẽ gọi API lấy từ Backend.
    const mockPkAggCoords = [0n, 0n, 0n, 0n, 0n, 0n];

    writeContract({
      address: ESCROW_CONTRACT_ADDRESS,
      abi: factoryAbi,
      functionName: 'createEscrow',
      args: [
        formData.seller,
        formData.mediator,
        mockPkAggCoords,
        parseEther(formData.amount), // Chuyển đổi từ số ETH (VD: 0.1) sang Wei
        BigInt(formData.confirmDays),
        BigInt(formData.timeoutDays)
      ],
    });
  };

  return (
    <div className="max-w-2xl mx-auto mt-10 bg-gray-900/50 p-8 rounded-xl border border-gray-800 backdrop-blur-sm shadow-xl">
      <h2 className="text-3xl font-orbitron text-primary mb-6 text-center border-b border-gray-800 pb-4">
        Khởi Tạo Hợp Đồng Ký Quỹ
      </h2>

      <form onSubmit={handleSubmit} className="space-y-5 font-exo">
        <div>
          <label className="block text-gray-400 mb-2">Địa chỉ ví Người bán (Seller)</label>
          <input 
            type="text" name="seller" required
            placeholder="0x..."
            value={formData.seller} onChange={handleChange}
            className="w-full p-3 bg-gray-800 text-white rounded outline-none focus:ring-2 focus:ring-primary border border-gray-700 transition"
          />
        </div>

        <div>
          <label className="block text-gray-400 mb-2">Địa chỉ ví Người hòa giải (Mediator)</label>
          <input 
            type="text" name="mediator" required
            placeholder="0x..."
            value={formData.mediator} onChange={handleChange}
            className="w-full p-3 bg-gray-800 text-white rounded outline-none focus:ring-2 focus:ring-primary border border-gray-700 transition"
          />
        </div>

        <div className="grid grid-cols-2 gap-5">
          <div>
            <label className="block text-gray-400 mb-2">Số tiền Ký quỹ (ETH)</label>
            <input 
              type="number" step="0.0001" name="amount" required
              placeholder="0.5"
              value={formData.amount} onChange={handleChange}
              className="w-full p-3 bg-gray-800 text-white rounded outline-none focus:ring-2 focus:ring-primary border border-gray-700 transition"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-gray-400 mb-2 text-sm">Hạn xác nhận (Ngày)</label>
              <input 
                type="number" name="confirmDays" required
                value={formData.confirmDays} onChange={handleChange}
                className="w-full p-3 bg-gray-800 text-white rounded outline-none focus:ring-2 focus:ring-primary border border-gray-700 transition"
              />
            </div>
            <div>
              <label className="block text-gray-400 mb-2 text-sm">Hạn giải quyết (Ngày)</label>
              <input 
                type="number" name="timeoutDays" required
                value={formData.timeoutDays} onChange={handleChange}
                className="w-full p-3 bg-gray-800 text-white rounded outline-none focus:ring-2 focus:ring-primary border border-gray-700 transition"
              />
            </div>
          </div>
        </div>

        <button 
          type="submit" 
          disabled={isPending || isConfirming}
          className="w-full mt-6 py-4 font-bold text-lg bg-accent text-black rounded hover:bg-yellow-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending ? 'Đang mở MetaMask...' : isConfirming ? 'Đang xử lý trên Blockchain...' : 'Ký Quỹ Ngay'}
        </button>
      </form>

      {/* Hiển thị trạng thái giao dịch */}
      {hash && (
        <div className="mt-4 p-4 bg-gray-800/80 rounded border border-gray-700 text-sm break-all">
          <p className="text-gray-300">Transaction Hash: <span className="text-green-400">{hash}</span></p>
        </div>
      )}
      {isConfirmed && (
        <div className="mt-2 p-3 bg-green-900/30 border border-green-800 text-green-400 rounded text-center font-bold">
          Tạo Hợp đồng Ký quỹ thành công!
        </div>
      )}
      {error && (
        <div className="mt-2 p-3 bg-red-900/30 border border-red-800 text-red-400 rounded text-sm">
          Lỗi: {error.shortMessage || error.message}
        </div>
      )}
    </div>
  );
}
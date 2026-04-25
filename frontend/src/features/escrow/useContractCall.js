import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem'; // Chuyển đổi ETH sang Wei
import { vaultAbi, factoryAbi } from '../../lib/abis'; // Đã thêm factoryAbi
import { useSetAtom } from 'jotai';
import { addSystemLogAtom } from './escrowStore';
import { useEffect } from 'react';

export const useContractCall = () => {
  const addLog = useSetAtom(addSystemLogAtom);
  
  const { writeContractAsync, data: hash, isPending, error: writeError } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ 
    hash 
  });

  useEffect(() => {
    if (isConfirmed && hash) {
      addLog({ message: `Transaction confirmed on-chain! Hash: ${hash}`, type: 'success' });
    }
  }, [isConfirmed, hash, addLog]);

  useEffect(() => {
    if (writeError) {
      addLog({ message: `Transaction rejected or failed: ${writeError.message.split('\n')[0]}`, type: 'error' });
    }
  }, [writeError, addLog]);

  // --- BẢN VÁ PHASE 1.5: HÀM KHỞI TẠO VAULT TỪ FACTORY ---
  const deployEscrowVault = async (factoryAddress, sellerAddr, mediatorAddrs, pkAggCoords, amountEth) => {
    if (!factoryAddress) throw new Error("Missing VITE_ESCROW_CONTRACT_ADDRESS in .env");
    
    addLog({ message: `Requesting MetaMask to deploy new Vault Contract...`, type: 'warning' });
    
    await writeContractAsync({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: 'createEscrow',
      args: [
        sellerAddr,
        mediatorAddrs, 
        pkAggCoords,   
        parseEther(amountEth.toString()), 
        BigInt(7),     
        BigInt(14)     
      ]
    });
  };

  // --- BẢN VÁ PHASE 2: HÀM NẠP TIỀN CHO BUYER ---
  const fundEscrow = async (vaultContractAddress, amountEth) => {
    if (!vaultContractAddress) throw new Error("Vault Contract Address is missing. Please check VITE_ESCROW_CONTRACT_ADDRESS.");
    if (!amountEth || isNaN(amountEth)) throw new Error("Invalid amount.");

    addLog({ message: `Requesting MetaMask to lock ${amountEth} ETH on-chain...`, type: 'warning' });
    
    // Gọi hàm lockFunds (payable) trên Smart Contract
    await writeContractAsync({
      address: vaultContractAddress,
      abi: vaultAbi,
      functionName: 'lockFunds', // Đã sửa chuẩn theo ABI main
      value: parseEther(amountEth.toString()), 
    });
  };

 const executeTssAction = async (actionType, signatureData) => {
    // 1. Kiểm tra đầu vào cơ bản
    if (!['release', 'refund'].includes(actionType)) {
      addLog({ message: `Lỗi Code: Sai actionType ${actionType}`, type: 'error' });
      return;
    }

    const targetAddress = signatureData?.vaultContractAddress;
    if (!targetAddress) {
      addLog({ message: "Lỗi Code: Thiếu Vault Contract Address từ Backend!", type: 'error' });
      return;
    }

    addLog({ message: `Đang gửi lệnh ${actionType} tới Contract: ${targetAddress}...`, type: 'info' });

    try {
      // 2. Thực thi lệnh
      await writeContractAsync({
        address: targetAddress,
        abi: vaultAbi,
        functionName: actionType, 
        args: [
          signatureData.R_addr,
          signatureData.z,
          signatureData.e,
          signatureData.msgHash,
          signatureData.signerBitmap || 31 // Giữ số 31 (5 người) hoặc tùy logic của bạn
        ]
      });
      
    } catch (error) {
      // =====================================================================
      // 3. MÁY QUÉT LỖI XUYÊN THẤU CỦA VIEM (BẮT ĐÚNG TÊN LỖI TRONG SOLIDITY)
      // =====================================================================
      console.error("🛑 [LOG GỐC] Toàn bộ Object Lỗi:", error);
      
      let exactReason = "Không xác định (Hãy xem Console log gốc)";

      // Viem giấu lỗi thật dưới nhiều lớp, dùng hàm .walk() để đào xuống
      if (typeof error.walk === 'function') {
        const revertError = error.walk((e) => e.name === 'ContractFunctionRevertedError');
        
        if (revertError) {
          // Trích xuất tên lỗi (Ví dụ: InvalidSignature, NotParticipant...)
          exactReason = revertError.data?.errorName || revertError.reason || revertError.shortMessage || "Revert không có thông điệp";
          
          console.error("🚨 [TÌM THẤY] Lỗi gốc từ Smart Contract:", exactReason);
          addLog({ 
            message: `❌ SMART CONTRACT TỪ CHỐI! Lý do thật: ${exactReason}`, 
            type: 'error' 
          });
          // Bật luôn Alert để đập vào mắt, không cần mở Console cũng thấy
          alert(`Smart Contract đá văng giao dịch!\nLý do: ${exactReason}`);
          return;
        }
      }

      // Nếu không phải lỗi Revert (ví dụ: người dùng ấn Hủy trên MetaMask)
      exactReason = error.shortMessage || error.message;
      console.error("⚠️ [LỖI NGOÀI] Người dùng hủy hoặc lỗi mạng:", exactReason);
      addLog({ message: `⚠️ Lỗi: ${exactReason}`, type: 'warning' });
    }
  };

  return {
    deployEscrowVault, // Export hàm deploy (Fix lỗi is not defined)
    fundEscrow,        // Export hàm nạp tiền
    executeTssAction,  // Export hàm chạy TSS
    isPending,    
    isConfirming,  
    isConfirmed,   
    hash
  };
};
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem'; // Chuyển đổi ETH sang Wei
import { vaultAbi } from '../../lib/abis'; 
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

  // --- BẢN VÁ PHASE 2: HÀM NẠP TIỀN CHO BUYER ---
  const fundEscrow = async (vaultContractAddress, amountEth) => {
    if (!vaultContractAddress) throw new Error("Vault Contract Address is missing. Please check VITE_ESCROW_CONTRACT_ADDRESS.");
    if (!amountEth || isNaN(amountEth)) throw new Error("Invalid amount.");

    addLog({ message: `Requesting MetaMask to lock ${amountEth} ETH on-chain...`, type: 'warning' });
    
    // Gọi hàm deposit (payable) trên Smart Contract
    await writeContractAsync({
      address: vaultContractAddress,
      abi: vaultAbi,
      functionName: 'deposit', // Đổi tên này nếu Smart Contract của bạn dùng tên khác (ví dụ: 'fund', 'lockFunds')
      value: parseEther(amountEth.toString()), 
    });
  };

  // Đổi tên hàm và thêm tham số actionType ('release' hoặc 'refund')
  const executeTssAction = async (actionType, signatureData) => {
    if (!['release', 'refund'].includes(actionType)) {
      throw new Error(`Invalid Smart Contract action: ${actionType}`);
    }
    if (!signatureData?.vaultContractAddress) throw new Error("Vault Contract Address is missing.");
    if (!signatureData?.R_addr || !signatureData?.z || !signatureData?.e || !signatureData?.msgHash) {
      throw new Error("Invalid Schnorr signature payload structure.");
    }
    
    addLog({ message: `Requesting wallet signature for ${actionType.toUpperCase()}...`, type: 'warning' });
    
    // Đẩy Transaction lên Blockchain với functionName động
    await writeContractAsync({
      address: signatureData.vaultContractAddress,
      abi: vaultAbi,
      functionName: actionType, // Sẽ tự động gọi 'release' hoặc 'refund'
      args: [
        signatureData.R_addr,
        signatureData.z,
        signatureData.e,
        signatureData.msgHash
      ]
    });
  };

  return {
    fundEscrow,       // Export hàm nạp tiền
    executeTssAction, // Export hàm chạy TSS
    isPending,    
    isConfirming,  
    isConfirmed,   
    hash
  };
};
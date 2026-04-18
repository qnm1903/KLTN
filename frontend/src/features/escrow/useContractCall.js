import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
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
    executeTssAction, // Export hàm mới
    isPending,    
    isConfirming,  
    isConfirmed,   
    hash
  };
};
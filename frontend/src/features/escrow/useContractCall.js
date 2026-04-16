import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { vaultAbi } from '../../lib/abis'; 
import { useSetAtom } from 'jotai';
import { addSystemLogAtom } from './escrowStore';
import { useEffect } from 'react';

export const useContractCall = () => {
  const addLog = useSetAtom(addSystemLogAtom);
  
  // Hook của Wagmi v3 dùng writeContractAsync để bắt Promise
  const { writeContractAsync, data: hash, isPending, error: writeError } = useWriteContract();

  // Lắng nghe trạng thái confirm trên network
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ 
    hash 
  });

  // Tự động log khi giao dịch thành công
  useEffect(() => {
    if (isConfirmed && hash) {
      addLog({ message: `Transaction confirmed on-chain! Hash: ${hash}`, type: 'success' });
    }
  }, [isConfirmed, hash, addLog]);

  // Tự động log nếu user reject trên Metamask
  useEffect(() => {
    if (writeError) {
      addLog({ message: `Transaction rejected or failed: ${writeError.message.split('\n')[0]}`, type: 'error' });
    }
  }, [writeError, addLog]);

  // Hàm gọi chính, nhận toàn bộ payload từ Backend
  const executeRelease = async (signatureData) => {
    // Ràng buộc bảo mật: Phải có đủ bộ chữ ký và địa chỉ vault
    if (!signatureData?.vaultContractAddress) throw new Error("Vault Contract Address is missing from signature payload.");
    if (!signatureData?.R_addr || !signatureData?.z || !signatureData?.e || !signatureData?.msgHash) {
      throw new Error("Invalid Schnorr signature payload structure.");
    }
    
    addLog({ message: 'Requesting wallet signature... Please check Metamask.', type: 'warning' });
    
    // Đẩy Transaction lên Blockchain
    await writeContractAsync({
      address: signatureData.vaultContractAddress,
      abi: vaultAbi,
      functionName: 'release',
      args: [
        signatureData.R_addr,
        signatureData.z,
        signatureData.e,
        signatureData.msgHash
      ]
    });
  };

  return {
    executeRelease,
    isPending,     // True khi Metamask đang hiện popup chờ user bấm Confirm
    isConfirming,  // True khi Tx đã gửi đi và đang chờ Block xác nhận
    isConfirmed,   // True khi Tx đã nằm an toàn trên Blockchain
    hash
  };
};
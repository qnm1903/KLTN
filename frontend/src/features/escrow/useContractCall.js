import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { vaultAbi, factoryAbi } from '../../lib/abis';
import { useSetAtom } from 'jotai';
import { addSystemLogAtom } from './escrowStore';
import { useCallback, useEffect } from 'react';

const VAULT_STATUS = Object.freeze({
  CREATED: 0,
  LOCKED: 1,
  RELEASED: 2,
  REFUNDED: 3,
  DISPUTED: 4
});

const VAULT_STATUS_LABELS = Object.freeze({
  [VAULT_STATUS.CREATED]: 'CREATED',
  [VAULT_STATUS.LOCKED]: 'LOCKED',
  [VAULT_STATUS.RELEASED]: 'RELEASED',
  [VAULT_STATUS.REFUNDED]: 'REFUNDED',
  [VAULT_STATUS.DISPUTED]: 'DISPUTED'
});

function getVaultStatusLabel(status) {
  return VAULT_STATUS_LABELS[Number(status)] || `UNKNOWN(${status})`;
}

function extractViemReason(error) {
  if (!error) return 'Unknown error';

  if (typeof error.walk === 'function') {
    const revertError = error.walk((e) => e.name === 'ContractFunctionRevertedError');
    if (revertError) {
      return revertError.data?.errorName || revertError.reason || revertError.shortMessage || 'Revert without message';
    }
  }

  return error.shortMessage || error.message || 'Unknown error';
}

export const useContractCall = () => {
  const addLog = useSetAtom(addSystemLogAtom);
  const publicClient = usePublicClient();
  const { address: walletAddress } = useAccount();

  const { writeContractAsync, data: hash, isPending, error: writeError } = useWriteContract();

  // Giảm tần suất tự động quét block của Wagmi xuống 5s (tránh Rate Limit và rác stream)
  const { isLoading: isConfirming, isSuccess: isConfirmed, error: receiptError } = useWaitForTransactionReceipt({
    hash,
    query: {
      refetchInterval: 5000, 
    }
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

  useEffect(() => {
    if (receiptError) {
      const receiptMsg = receiptError?.shortMessage || receiptError?.message || 'Transaction reverted on-chain';
      addLog({ message: `Transaction mined but reverted: ${receiptMsg.split('\n')[0]}`, type: 'error' });
    }
  }, [receiptError, addLog]);

  // Deploy vault via factory contract
  const deployEscrowVault = async (factoryAddress, sellerAddr, mediatorAddrs, pkAggCoords, amountEth) => {
    if (!factoryAddress) throw new Error('Missing VITE_ESCROW_CONTRACT_ADDRESS in .env');

    addLog({ message: 'Requesting MetaMask to deploy new Vault Contract...', type: 'warning' });

    return await writeContractAsync({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: 'createEscrow',
      args: [
        sellerAddr,
        mediatorAddrs,
        pkAggCoords,
        parseEther(amountEth.toString()),
        BigInt(7),
        BigInt(14),
        // threshold: 5-of-7 signing scheme (buyer + seller + 5 mediators = 7 parties)
        BigInt(5)
      ],
    });
  };

  const getVaultStatus = useCallback(async (vaultContractAddress) => {
    if (!vaultContractAddress) {
      throw new Error('Vault Contract Address is missing.');
    }

    if (!publicClient) {
      throw new Error('Cannot read on-chain vault status right now. Please check wallet/RPC connection.');
    }

    const maxRetries = 5;
    const retryDelay = 2000; // 2 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const rawStatus = await publicClient.readContract({
          address: vaultContractAddress,
          abi: vaultAbi,
          functionName: 'status'
        });

        // Check if status is valid (not 0x or undefined)
        if (rawStatus === undefined || rawStatus === '0x' || rawStatus === null) {
          throw new Error('Status returned no data');
        }

        return Number(rawStatus);
      } catch (error) {
        const errorMessage = error?.shortMessage || error?.message || 'Unknown error';
        
        // If this is the last retry, throw the error
        if (attempt === maxRetries) {
          throw new Error(`Failed after ${maxRetries} retries: ${errorMessage}`);
        }

        // Log retry attempt
        console.warn(`[getVaultStatus] Retry ${attempt}/${maxRetries}: ${errorMessage}`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    throw new Error('Max retries exceeded for getVaultStatus');
  }, [publicClient]);

  const simulateTssAction = useCallback(async (actionType, targetAddress, signatureData) => {
    if (!publicClient || !walletAddress) {
      return null;
    }

    try {
      await publicClient.simulateContract({
        account: walletAddress,
        address: targetAddress,
        abi: vaultAbi,
        functionName: actionType,
        args: [
          signatureData.R_addr,
          signatureData.z,
          signatureData.e,
          signatureData.msgHash,
          signatureData.signerBitmap || 31
        ],
        gas: 500000n
      });

      return null;
    } catch (error) {
      return extractViemReason(error);
    }
  }, [publicClient, walletAddress]);

  // Buyer deposit flow
  const fundEscrow = async (vaultContractAddress, amountEth) => {
    if (!vaultContractAddress) throw new Error('Vault Contract Address is missing. Please check VITE_ESCROW_CONTRACT_ADDRESS.');
    if (!amountEth || isNaN(amountEth)) throw new Error('Invalid amount.');

    let onChainStatus;
    try {
      onChainStatus = await getVaultStatus(vaultContractAddress);
    } catch (error) {
      const statusError = error?.shortMessage || error?.message || 'Unknown error while reading vault status';
      addLog({ message: `Cannot verify on-chain vault status: ${statusError}`, type: 'warning' });
      throw new Error('Cannot verify on-chain vault status. Please retry.');
    }

    if (onChainStatus !== VAULT_STATUS.CREATED) {
      const statusLabel = getVaultStatusLabel(onChainStatus);
      addLog({ message: `Vault is already ${statusLabel} on-chain. Skip duplicate deposit.`, type: 'warning' });
      throw new Error(`Vault already ${statusLabel} on-chain.`);
    }

    // addLog({ message: `Requesting MetaMask to lock ${amountEth} ETH on-chain...`, type: 'warning' });

    return await writeContractAsync({
      address: vaultContractAddress,
      abi: vaultAbi,
      functionName: 'lockFunds',
      value: parseEther(amountEth.toString())
    });
  };

  const executeTssAction = async (actionType, signatureData, fallbackAddress) => {
    if (!['release', 'refund', 'split'].includes(actionType)) {
      const invalidActionMessage = `Code error: invalid actionType ${actionType}`;
      addLog({ message: invalidActionMessage, type: 'error' });
      throw new Error(invalidActionMessage);
    }

    const targetAddress = signatureData?.vaultContractAddress || fallbackAddress;
    if (!targetAddress) {
      const missingAddressMessage = 'Code error: missing vault contract address from backend!';
      addLog({ message: missingAddressMessage, type: 'error' });
      throw new Error(missingAddressMessage);
    }

    addLog({
      message: `Sending ${actionType} to contract: ${targetAddress} (source: ${signatureData?.vaultContractAddress ? 'backend-signature' : 'fallback-ui'})...`,
      type: 'info'
    });

    try {
      const simulatedReason = await simulateTssAction(actionType, targetAddress, signatureData);
      if (simulatedReason) {
        addLog({
          message: `Preflight on-chain check failed: ${simulatedReason}`,
          type: 'error'
        });
        throw new Error(`Preflight failed: ${simulatedReason}`);
      }

       return await writeContractAsync({
        address: targetAddress,
        abi: vaultAbi,
        functionName: actionType,
        args: [
          signatureData.R_addr,
          signatureData.z,
          signatureData.e,
          signatureData.msgHash,
          signatureData.signerBitmap || 31
        ],
        // Avoid unreliable wallet/provider gas estimation that can throw
        // spurious "gas limit too high" for this heavy signature verification call.
        gas: 500000n
      });
    } catch (error) {
      console.error('[RAW ERROR] Full object:', error);

      const exactReason = extractViemReason(error);
      console.error('[SMART CONTRACT ERROR] Root reason:', exactReason);
      addLog({
        message: `Smart contract rejected transaction. Real reason: ${exactReason}`,
        type: 'error'
      });
      alert(`Smart contract rejected transaction.\nReason: ${exactReason}`);
      console.error('[NON-REVERT ERROR] Wallet cancelled or network issue:', exactReason);
      addLog({ message: `Warning: ${exactReason}`, type: 'warning' });
      throw new Error(exactReason);
    }
  };

  // ==========================================
  // BẮT ĐẦU THÊM MỚI: TX WAITER ĐỂ FIX MEMORY LEAK
  // ==========================================
  // Chỉnh thời gian nới lỏng vòng lặp thành 5 giây để đồng bộ với block time thực tế
  const waitForTx = useCallback(async (txHash, timeoutMs = 180000, pollInterval = 5000) => {
    if (!publicClient) throw new Error('publicClient is required to wait for tx');
    
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt) return receipt;
      } catch (e) {
        // Ignore transient RPC read errors and keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    throw new Error('Timeout waiting for transaction confirmation (180s exceeded)');
  }, [publicClient]);

  return {
    deployEscrowVault,
    fundEscrow,
    getVaultStatus,
    executeTssAction,
    waitForTx,
    isPending,
    isConfirming,
    isConfirmed,
    hash
  };
};

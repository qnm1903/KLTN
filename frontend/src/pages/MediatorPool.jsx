import React, { useState, useEffect, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { useAtomValue } from 'jotai';
import { toast } from 'react-toastify';
import api from '../lib/api';
import { authAtom } from '../store/authStore';
import { mediatorPoolAbi } from '../lib/abis';

const POOL_ADDRESS = import.meta.env.VITE_MEDIATOR_POOL_CONTRACT;

export default function MediatorPool() {
  const { address, isConnected } = useAccount();
  const auth = useAtomValue(authAtom);
  const [poolStatus, setPoolStatus] = useState(null);
  const [pendingAction, setPendingAction] = useState(null); // 'register' | 'unregister'
  const [refreshKey, setRefreshKey] = useState(0);

  const { data: requiredStake } = useReadContract({
    address: POOL_ADDRESS,
    abi: mediatorPoolAbi,
    functionName: 'getRequiredStake',
    query: { enabled: !!POOL_ADDRESS },
  });

  const { data: mediatorInfo, refetch: refetchMediator } = useReadContract({
    address: POOL_ADDRESS,
    abi: mediatorPoolAbi,
    functionName: 'mediators',
    args: [address],
    query: { enabled: !!POOL_ADDRESS && !!address },
  });

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    isError: isWriteError,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isTxConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Load pool statistics
  useEffect(() => {
    api.get('/mediator/pool-status')
      .then(({ data }) => setPoolStatus(data))
      .catch(() => {});
  }, [refreshKey]);

  // Clear pending action if user rejects wallet prompt
  useEffect(() => {
    if (isWriteError) setPendingAction(null);
  }, [isWriteError]);

  // After tx confirmed on-chain, sync to backend DB
  useEffect(() => {
    if (!isTxConfirmed || !txHash || !pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);

    api.post(`/mediator/${action}`, { txHash })
      .then(() => {
        toast.success(action === 'register'
          ? 'Successfully joined the mediator pool!'
          : 'Successfully left the mediator pool!');
        setRefreshKey(k => k + 1);
        refetchMediator();
        resetWrite();
      })
      .catch(err => {
        toast.error(err.response?.data?.error || 'Backend sync failed — please refresh');
      });
  }, [isTxConfirmed, txHash, pendingAction, refetchMediator, resetWrite]);

  const handleRegister = useCallback(() => {
    if (!POOL_ADDRESS || requiredStake == null) return;
    setPendingAction('register');
    writeContract({
      address: POOL_ADDRESS,
      abi: mediatorPoolAbi,
      functionName: 'registerAsMediator',
      value: requiredStake,
    });
  }, [requiredStake, writeContract]);

  const handleUnregister = useCallback(() => {
    if (!POOL_ADDRESS) return;
    setPendingAction('unregister');
    writeContract({
      address: POOL_ADDRESS,
      abi: mediatorPoolAbi,
      functionName: 'unregister',
    });
  }, [writeContract]);

  const isMediator = mediatorInfo?.isActive === true;
  const stakeEth = requiredStake != null ? formatEther(requiredStake) : null;
  const isBusy = isWritePending || isConfirming;
  const busyLabel = isConfirming ? 'Confirming on-chain...' : 'Waiting for wallet...';

  if (!isConnected) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-20 text-center">
        <h1 className="text-3xl font-orbitron font-bold text-white mb-4">Mediator Pool</h1>
        <p className="text-gray-400">Connect your wallet to manage your mediator status.</p>
      </main>
    );
  }

  if (!auth?.isAuthenticated) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-20 text-center">
        <h1 className="text-3xl font-orbitron font-bold text-white mb-4">Sign In Required</h1>
        <p className="text-gray-400">Please sign in with SIWE to manage your mediator status.</p>
      </main>
    );
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-4xl font-orbitron font-bold text-white mb-2">Mediator Pool</h1>
        <p className="text-gray-400">
          Become a neutral arbitrator for escrow disputes. Selected randomly via Chainlink VRF — no bias, no favoritism.
        </p>
      </div>

      {/* Pool Stats */}
      <div className="grid grid-cols-3 gap-4 mb-10">
        {[
          {
            label: 'Active Mediators',
            value: poolStatus?.totalMediators ?? '...',
            sub: `Min required: ${poolStatus?.minRequired ?? 5}`,
          },
          {
            label: 'Required Stake',
            value: stakeEth ? `${stakeEth} ETH` : '...',
            sub: 'Returned when you exit',
          },
          {
            label: 'Pool Status',
            value: poolStatus == null ? '...' : poolStatus.canCreateEscrow ? 'Ready' : 'Insufficient',
            sub: 'Minimum 5 mediators needed',
            color: poolStatus?.canCreateEscrow ? 'text-emerald-400' : 'text-red-400',
          },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
            <p className="text-gray-400 text-sm mb-1">{label}</p>
            <p className={`text-2xl font-bold font-mono ${color ?? 'text-white'}`}>{value}</p>
            <p className="text-gray-500 text-xs mt-1">{sub}</p>
          </div>
        ))}
      </div>

      {/* User Status Panel */}
      {isMediator ? (
        <div className="bg-emerald-900/20 border border-emerald-500/30 rounded-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
            <h2 className="text-xl font-bold text-emerald-400">You are an Active Mediator</h2>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-3 mb-8 text-sm font-mono">
            {[
              ['Reputation Score', `${mediatorInfo?.reputationScore ?? 0} / 100`],
              ['Stake Locked', `${mediatorInfo?.stakeAmount != null ? formatEther(mediatorInfo.stakeAmount) : '...'} ETH`],
              ['Total Votes', mediatorInfo?.totalVotes?.toString() ?? '0'],
              ['Successful Votes', mediatorInfo?.successfulVotes?.toString() ?? '0'],
              ['Timeout Count', `${mediatorInfo?.timeoutCount ?? 0} / 3 max`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-slate-700/60 pb-2">
                <span className="text-gray-400">{k}</span>
                <span className="text-white font-semibold">{v}</span>
              </div>
            ))}
          </div>

          <p className="text-yellow-500/80 text-xs mb-4">
            Warning: Your staked ETH will be returned, minus any slashing penalties incurred.
          </p>
          <button
            onClick={handleUnregister}
            disabled={isBusy}
            className="w-full py-3 bg-red-900/40 border border-red-500/50 text-red-400 font-bold rounded-xl hover:bg-red-900/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isBusy ? busyLabel : 'Leave Mediator Pool'}
          </button>
        </div>
      ) : (
        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
          <h2 className="text-xl font-bold text-white mb-3">Join as Mediator</h2>
          <p className="text-gray-400 text-sm mb-6">
            Stake{' '}
            <span className="text-yellow-400 font-mono font-bold">{stakeEth ? `${stakeEth} ETH` : '...'}</span>
            {' '}to participate. Your stake is returned when you leave (unless slashed for misconduct).
          </p>

          <ul className="text-sm text-gray-400 space-y-2 mb-8">
            {[
              'Selected by Chainlink VRF — fully random, tamper-proof',
              'Start with a 50/100 reputation score',
              'Build reputation by resolving disputes fairly',
              'Stake slashed for timeouts or malicious behavior',
            ].map(item => (
              <li key={item} className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>

          {!POOL_ADDRESS ? (
            <p className="text-red-400 text-sm text-center">
              Contract not configured. Set <code className="bg-slate-700 px-1 rounded">VITE_MEDIATOR_POOL_CONTRACT</code> in .env.
            </p>
          ) : (
            <button
              onClick={handleRegister}
              disabled={isBusy || stakeEth == null}
              className="w-full py-3 bg-primary hover:bg-blue-600 text-white font-bold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-[0_0_20px_rgba(30,58,138,0.4)]"
            >
              {isBusy ? busyLabel : `Register & Stake ${stakeEth ?? '...'} ETH`}
            </button>
          )}
        </div>
      )}
    </main>
  );
}

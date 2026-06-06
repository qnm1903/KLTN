import { useEffect, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { useAccount } from 'wagmi';
import {
  signatureProgressAtom,
  signedNodesAtom,
  addSystemLogAtom,
  escrowStatusAtom,
  signingPhaseAtom,
  nonceRound1Atom,
  aggregatedSignatureAtom,
  signingProgressAtom
} from './escrowStore';
import api from '../../lib/api';
import { getStoredAccessToken } from '../../store/authStore';
import { socket, joinEscrowRoom, leaveEscrowRoom } from '../../lib/socket';
import { clearNonceRecord } from '../../lib/storage';

const PARTICIPANT_ROLES = ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3', 'mediator4', 'mediator5'];

function toStatusState(collectionState) {
  if (collectionState === 'COMPLETE') return 'completed';
  if (collectionState === 'EXPIRED') return 'error';
  if (collectionState === 'PARTIAL') return 'computing_keys';
  return 'dkg_ready';
}

function submittedRolesFromCollection(collection) {
  if (!collection || !Array.isArray(collection.missingRoles)) return [];
  const missing = new Set(collection.missingRoles);
  return PARTICIPANT_ROLES.filter((role) => !missing.has(role));
}

export const useEscrowSync = (escrowId, escrowStatus) => {
  const { address } = useAccount();
  const [, setProgress] = useAtom(signatureProgressAtom);
  const [, setSignedNodes] = useAtom(signedNodesAtom);
  const setStatus = useSetAtom(escrowStatusAtom);
  const addLog = useSetAtom(addSystemLogAtom);
  const setSigningPhase = useSetAtom(signingPhaseAtom);
  const setNonceRound1 = useSetAtom(nonceRound1Atom);
  const setAggregatedSignature = useSetAtom(aggregatedSignatureAtom);
  const setSigningProgress = useSetAtom(signingProgressAtom);

  const applyCollectionSnapshot = useCallback((collection, { authoritative = false } = {}) => {
    if (!collection) return;
    const received = Number(collection.received || 0);
    // authoritative=true (API sync) sets exact value; socket events only increase
    setProgress((prev) => authoritative ? received : Math.max(prev, received));
    setSignedNodes((prev) => {
      const newNodes = submittedRolesFromCollection(collection);
      return authoritative ? newNodes : (newNodes.length > prev.length ? newNodes : prev);
    });
    setStatus(toStatusState(collection.state));
  }, [setProgress, setSignedNodes, setStatus]);

  // LUỒNG 1: Lấy Status API độc lập (Tránh reload socket)
  useEffect(() => {
    if (!escrowId) return;
    let isMounted = true;
    
    const normalizedStatus = String(escrowStatus || '').toUpperCase();
    const tssAllowed = ['DRAFT', 'INITIALIZED', 'LOCKED', 'DISPUTED', 'RESOLVED'].includes(normalizedStatus);
    
    if (tssAllowed) {
      api.get(`/escrow/${escrowId}/status`).then(({ data }) => {
        if (isMounted) applyCollectionSnapshot(data?.pubkeyCollection, { authoritative: true });
      }).catch(() => {
         // Silently ignore sync errors
      });
    }

    return () => { isMounted = false; };
  }, [escrowId, escrowStatus, applyCollectionSnapshot]);

  // LUỒNG 2: Xử lý Socket.io (Chỉ phụ thuộc EscrowId)
  useEffect(() => {
    if (!escrowId) return;
    
    const currentToken = getStoredAccessToken();
    if (!currentToken) return;

    if (!socket.connected) {
      socket.connect();
    }

    joinEscrowRoom(escrowId, currentToken).then((response) => {
      if (response?.ok) {
        addLog({ message: `Joined secure room for Escrow #${escrowId}`, type: 'success' });
      }
    });

    const handlePubKeyReceived = (data) => {
      if (data?.escrowId !== escrowId) return;
      setSignedNodes((prev) => {
        if (prev.includes(data.role)) return prev;
        return [...prev, data.role];
      });
      if (Number.isFinite(data?.received)) {
        setProgress((prev) => Math.max(prev, data.received));
      }
      addLog({ message: `Received pubkey from ${data.role}. (${data.received || 0}/7)`, type: 'info' });
    };

    const handlePubKeyRejected = (data) => {
      if (data?.escrowId !== escrowId) return;
      addLog({ message: `Pubkey rejected for ${data.role}: ${data.reason}`, type: 'error' });
    };

    const handleCollectionComplete = (data) => {
      if (data?.escrowId !== escrowId) return;
      setProgress(7);
      setSignedNodes(PARTICIPANT_ROLES);
      setStatus('completed');
      addLog({ message: `All DKG signing keys submitted (${data.received || 7}/7). Ready to deploy.`, type: 'success' });
    };

    const handleCollectionExpired = (data) => {
      if (data?.escrowId !== escrowId) return;
      setStatus('error');
      addLog({ message: `Pubkey collection expired at ${data.expiredAt || 'unknown time'}.`, type: 'error' });
    };

    const handleNonceReceived = (data) => {
      if (data?.escrowId !== escrowId) return;
      setSigningProgress({ round: 1, submitted: data.count, needed: data.needed, percentage: Math.round((data.count / data.needed) * 100) });
      addLog({ message: `Nonce submission: ${data.count}/${data.needed}`, type: 'info' });
    };

    const handleNonceCollected = (data) => {
      if (data?.escrowId !== escrowId) return;
      setSigningPhase("z-share");
      setNonceRound1(data);
      addLog({ message: 'Round 1 complete! Challenge computed. Start Round 2 now.', type: 'success' });
    };

    const handleZReceived = (data) => {
      if (data?.escrowId !== escrowId) return;
      setSigningProgress({ round: 2, submitted: data.count, needed: data.needed, percentage: Math.round((data.count / data.needed) * 100) });
      addLog({ message: `Z-share submission: ${data.count}/${data.needed}`, type: 'info' });
    };

    const handleSchnorrComplete = (data) => {
      if (data?.escrowId !== escrowId) return;
      setSigningPhase("ready");
      setAggregatedSignature(data);
      addLog({ message: 'Signature aggregated! Ready for contract call.', type: 'success' });
    };

    const handleSigningReset = (data) => {
      if (data?.escrowId !== escrowId) return;
      setSigningPhase('dkg_ready');
      setNonceRound1(null);
      setAggregatedSignature(null);
      addLog({ message: `⚠️ ${data.message || 'Signing session reset by another participant.'}`, type: 'error' });
    };

    const handleDkgReset = (data) => {
      if (data?.escrowId !== escrowId) return;
      setProgress(0);
      setSignedNodes([]);
      setStatus('dkg_ready');
      addLog({ message: `⚠️ DKG đã bị reset bởi một participant. Tất cả parties cần chạy lại DKG.`, type: 'error' });
    };

    socket.on('pubkey_received', handlePubKeyReceived);
    socket.on('pubkey_rejected', handlePubKeyRejected);
    socket.on('pubkey_collection_complete', handleCollectionComplete);
    socket.on('pubkey_collection_expired', handleCollectionExpired);
    socket.on('nonce_received', handleNonceReceived);
    socket.on('nonce_collected', handleNonceCollected);
    socket.on('z_received', handleZReceived);
    socket.on('schnorr_complete', handleSchnorrComplete);
    socket.on('signing_reset', handleSigningReset);
    socket.on('dkg_reset', handleDkgReset);

    return () => {
      socket.off('pubkey_received', handlePubKeyReceived);
      socket.off('pubkey_rejected', handlePubKeyRejected);
      socket.off('pubkey_collection_complete', handleCollectionComplete);
      socket.off('pubkey_collection_expired', handleCollectionExpired);
      socket.off('nonce_received', handleNonceReceived);
      socket.off('nonce_collected', handleNonceCollected);
      socket.off('z_received', handleZReceived);
      socket.off('schnorr_complete', handleSchnorrComplete);
      socket.off('signing_reset', handleSigningReset);
      socket.off('dkg_reset', handleDkgReset);
      leaveEscrowRoom(escrowId);
    };
  }, [escrowId, setProgress, setSignedNodes, setStatus, addLog, setSigningPhase, setNonceRound1, setSigningProgress, setAggregatedSignature]);

  const submitPubKey = useCallback(async ({ role, pubKey }) => {
    if (!escrowId) throw new Error('Escrow id is required');
    if (!role || !pubKey) throw new Error('role and pubKey are required');

    const normalizedStatus = String(escrowStatus || '').toUpperCase();
    if (!['DRAFT', 'INITIALIZED', 'LOCKED', 'DISPUTED'].includes(normalizedStatus)) {
      addLog({ message: 'Cannot submit pubkey: Escrow status is not ready for DKG.', type: 'warning' });
      throw new Error('Escrow not ready for pubkey submission');
    }

    addLog({ message: `Submitting pubkey for role ${role}...`, type: 'warning' });

    const { data } = await api.post('/escrow/pubkey/submit', { escrowId, role, pubKey });
    applyCollectionSnapshot(data?.collection);

    if (data?.isIdempotent) {
      addLog({ message: 'Your pubkey was already submitted before (idempotent).', type: 'info' });
    } else {
      addLog({ message: `Pubkey accepted for role ${role}.`, type: 'success' });
    }
    return data;
  }, [escrowId, escrowStatus, addLog, applyCollectionSnapshot]);

  const submitNonce = useCallback(async (escrowId, role, action, signerBitmap, R_x, R_y, R2_x, R2_y) => {
    // Đảm bảo Session JWT khớp với Ví MetaMask hiện tại
    const token = getStoredAccessToken();
    if (!token) throw new Error('Yêu cầu xác thực: Vui lòng đăng nhập (SIWE) trước khi thực hiện.');

    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const tokenWallet = String(payload?.walletAddress || payload?.address || '').toLowerCase();
        const connectedWallet = String(address || '').toLowerCase();
        
        if (tokenWallet && connectedWallet && tokenWallet !== connectedWallet) {
          addLog({ message: `Auth mismatch: Phiên đăng nhập thuộc về ví ${tokenWallet.substring(0,6)}... Hãy đăng nhập lại!`, type: 'error' });
          throw new Error('Lỗi đồng bộ Ví: Phiên SIWE không khớp với ví MetaMask hiện tại. Vui lòng F5 và đăng nhập lại.');
        }
      }
    } catch (e) {
      if (e.message.includes('Lỗi đồng bộ Ví')) throw e;
      console.warn('[JWT Decode Warning]:', e);
    }

    addLog({ message: `Submitting Nonce for action: ${action}...`, type: 'warning' });
    try {
      const nonceBody = { escrowId, role, action, signerBitmap, R_x, R_y };
      if (R2_x && R2_y) { nonceBody.R2_x = R2_x; nonceBody.R2_y = R2_y; }
      const { data } = await api.post(`/escrow/nonce`, nonceBody);
      
      if (data.isIdempotent) {
        addLog({ message: `Nonce already submitted (idempotent), skipping...`, type: 'info' });
      }
      
      if (data.state === 'round2_ready') {
        addLog({ message: `Round 1 already complete. Skipping to Round 2.`, type: 'success' });
      } else if (data.state === 'round1_in_progress') {
        addLog({ message: `Round 1 in progress: ${data.received}/${data.needed} submitted. Your nonce differs from submitted value.`, type: 'warning' });
        if (data.existingNonce) {
          addLog({ message: `Clearing local nonce and requiring restart...`, type: 'error' });
          const nonceKey = `${escrowId}:${action}:${data.role || role}`;
          await clearNonceRecord(nonceKey);
          throw new Error(`Nonce mismatch: Your local nonce differs from backend. Please restart signing with a fresh nonce.`);
        }
      }
      
      return data;
    } catch (error) {
      if (error.response?.status === 409) {
        const errorMsg = error.response?.data?.error || 'Nonce conflict';
        addLog({ message: `⚠️ ${errorMsg}`, type: 'warning' });
        throw error;
      }
      throw error;
    }
  }, [addLog, address]); 

  const submitZShare = useCallback(async (escrowId, role, signerBitmap, z, challenge) => {
    addLog({ message: `Submitting Z-Share...`, type: 'warning' });
    try {
      const { data } = await api.post(`/escrow/sign`, { escrowId, role, signerBitmap, z, challenge });
      return data;
    } catch (error) {
      if (error.response?.status === 409) {
        // Stale challenge: z tính trên Round 1 cũ. Báo người dùng làm mới Round 2.
        addLog({ message: `⚠️ ${error.response?.data?.error || 'Stale challenge — refresh Round 2.'}`, type: 'error' });
      }
      throw error;
    }
  }, [addLog]);

  const resetSigning = useCallback(async (action, reason) => {
    addLog({ message: `Resetting signing session due to: ${reason}`, type: 'warning' });
    try {
      const { data } = await api.post(`/escrow/${escrowId}/reset-signing`, { action, reason });
      setSigningPhase('dkg_ready');
      setNonceRound1(null);
      setAggregatedSignature(null);
      addLog({ message: `Signing session reset. All participants must restart with fresh nonces.`, type: 'error' });
      return data;
    } catch (error) {
      if (error.response?.status === 404) {
        addLog({ message: `Session expired or not found. Please refresh the page and restart signing from the beginning.`, type: 'error' });
        setSigningPhase('dkg_ready');
        setNonceRound1(null);
        setAggregatedSignature(null);
      } else {
        addLog({ message: `Failed to reset signing: ${error.message}`, type: 'error' });
      }
      throw error;
    }
  }, [escrowId, addLog, setSigningPhase, setNonceRound1, setAggregatedSignature]);

  return { submitPubKey, submitNonce, submitZShare, resetSigning };
};
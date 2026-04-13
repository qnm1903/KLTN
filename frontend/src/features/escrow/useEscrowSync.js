import { useEffect, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import {
  signatureProgressAtom,
  signedNodesAtom,
  addSystemLogAtom,
  escrowStatusAtom
} from './escrowStore';
import api from '../../lib/api';
import { getStoredAccessToken } from '../../store/authStore';
import { socket } from '../../lib/socket';

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

/**
 * Custom Hook xử lý realtime pubkey collection theo luồng incremental.
 */
export const useEscrowSync = (escrowId) => {
  const [, setProgress] = useAtom(signatureProgressAtom);
  const [, setSignedNodes] = useAtom(signedNodesAtom);
  const setStatus = useSetAtom(escrowStatusAtom);
  const addLog = useSetAtom(addSystemLogAtom);
  const authToken = getStoredAccessToken();

  const applyCollectionSnapshot = useCallback((collection) => {
    if (!collection) return;

    setProgress(Number(collection.received || 0));
    setSignedNodes(submittedRolesFromCollection(collection));
    setStatus(toStatusState(collection.state));
  }, [setProgress, setSignedNodes, setStatus]);

  useEffect(() => {
    if (!escrowId) return;

    let isMounted = true;
    const token = authToken;

    const bootstrapCollection = async () => {
      try {
        const { data } = await api.get(`/escrow/${escrowId}/status`);
        if (!isMounted) return;
        applyCollectionSnapshot(data?.pubkeyCollection);
      } catch (error) {
        addLog({ message: `Cannot load collection snapshot: ${error.message}`, type: 'warning' });
      }
    };

    bootstrapCollection();

    if (!token) {
      addLog({ message: 'Socket realtime requires login token.', type: 'warning' });
      return () => {
        isMounted = false;
      };
    }

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit('join_escrow', { escrowId, token }, (response) => {
      if (response?.ok) {
        addLog({ message: `Joined secure room for Escrow #${escrowId}`, type: 'success' });
        return;
      }
      addLog({ message: `Join room failed: ${response?.error || 'unknown error'}`, type: 'error' });
    });

    const handlePubKeyReceived = (data) => {
      if (data?.escrowId !== escrowId) return;

      setSignedNodes((prev) => {
        if (prev.includes(data.role)) return prev;
        return [...prev, data.role];
      });

      if (Number.isFinite(data?.received)) {
        setProgress(data.received);
      }

      addLog({ message: `Received pubkey from ${data.role}. (${data.received || 0}/7)`, type: 'info' });
    };

    const handlePubKeyRejected = (data) => {
      if (data?.escrowId !== escrowId) return;
      addLog({ message: `Pubkey rejected for ${data.role}: ${data.reason}`, type: 'error' });
    };

    const handleCollectionComplete = (data) => {
      if (data?.escrowId !== escrowId) return;
      setProgress(Number(data.received || 7));
      setSignedNodes(PARTICIPANT_ROLES);
      setStatus('completed');
      addLog({ message: `All pubkeys collected (${data.received || 7}/7).`, type: 'success' });
    };

    const handleCollectionExpired = (data) => {
      if (data?.escrowId !== escrowId) return;
      setStatus('error');
      addLog({ message: `Pubkey collection expired at ${data.expiredAt || 'unknown time'}.`, type: 'error' });
    };

    const handleNonceCollected = () => {
      addLog({ message: 'Nonce round completed. Waiting for z-shares.', type: 'info' });
    };

    const handleSchnorrComplete = () => {
      addLog({ message: 'Schnorr signature completed and ready for on-chain execution.', type: 'success' });
    };

    socket.on('pubkey_received', handlePubKeyReceived);
    socket.on('pubkey_rejected', handlePubKeyRejected);
    socket.on('pubkey_collection_complete', handleCollectionComplete);
    socket.on('pubkey_collection_expired', handleCollectionExpired);
    socket.on('nonce_collected', handleNonceCollected);
    socket.on('schnorr_complete', handleSchnorrComplete);

    return () => {
      isMounted = false;
      socket.off('pubkey_received', handlePubKeyReceived);
      socket.off('pubkey_rejected', handlePubKeyRejected);
      socket.off('pubkey_collection_complete', handleCollectionComplete);
      socket.off('pubkey_collection_expired', handleCollectionExpired);
      socket.off('nonce_collected', handleNonceCollected);
      socket.off('schnorr_complete', handleSchnorrComplete);
      socket.emit('leave_escrow', escrowId);
    };
  }, [escrowId, authToken, setProgress, setSignedNodes, setStatus, addLog, applyCollectionSnapshot]);

  const submitPubKey = useCallback(async ({ role, pubKey }) => {
    if (!escrowId) {
      throw new Error('Escrow id is required');
    }

    if (!role || !pubKey) {
      throw new Error('role and pubKey are required');
    }

    addLog({ message: `Submitting pubkey for role ${role}...`, type: 'warning' });

    const { data } = await api.post('/escrow/pubkey/submit', {
      escrowId,
      role,
      pubKey
    });

    applyCollectionSnapshot(data?.collection);

    if (data?.isIdempotent) {
      addLog({ message: 'Your pubkey was already submitted before (idempotent).', type: 'info' });
    } else {
      addLog({ message: `Pubkey accepted for role ${role}.`, type: 'success' });
    }

    return data;
  }, [escrowId, addLog, applyCollectionSnapshot]);

  return { submitPubKey };
};
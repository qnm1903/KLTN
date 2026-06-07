import { useEffect } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { toast } from 'react-toastify';
import {
  currentDisputeAtom,
  evidenceListAtom,
  mediatorsListAtom,
  voteTallyAtom
} from '../store/disputeAtoms.js';

import { socket } from '../lib/socket.js';
import { getStoredAccessToken } from '../store/authStore.js';

import {
  MEDIATOR_STATUS,
  DISPUTE_STATUS
} from '../constants/dispute.constants.js';

export function useDisputeWebSocket(disputeId) {
  const currentDispute = useAtomValue(currentDisputeAtom);
  const setCurrentDispute = useSetAtom(currentDisputeAtom);
  const setEvidenceList = useSetAtom(evidenceListAtom);
  const setMediatorsList = useSetAtom(mediatorsListAtom);
  const setVoteTally = useSetAtom(voteTallyAtom);

  useEffect(() => {
    const actualEscrowId = currentDispute?.escrowId;
    if (!actualEscrowId) return; 

    const token = getStoredAccessToken();
    socket.emit('join_escrow', { escrowId: actualEscrowId, token }, (response) => {
      if (response?.error) {
        console.error('[Socket] join_escrow failed:', response.error);
      } else {
        console.log(`[Socket] ✅ Đã join thành công room Escrow: ${actualEscrowId}`);
      }
    });
  }, [currentDispute?.escrowId]);

  useEffect(() => {
    if (!socket || !disputeId) return undefined;

    try {
      const token = getStoredAccessToken();
      if (token && typeof socket.emit === 'function') {
        if (!socket.connected) {
          socket.connect();
        }
      }
    } catch (err) {
      console.warn('useDisputeWebSocket: join_escrow error:', err);
    }

    const handleDisputeCreated = (payload) => setCurrentDispute(payload);

    const handleMediatorsAssigned = (payload) => {
      const incoming = payload || {};
      const addrs = Array.isArray(incoming.mediators) ? incoming.mediators : [];

      const mediators = addrs.map((addr) => ({
        address: addr,
        status: MEDIATOR_STATUS.ASSIGNED,
        acceptedAt: null,
        declinedAt: null,
        votedAt: null,
        voteChoice: null,
        score: null,
        note: null
      }));

      setMediatorsList(mediators);
      setCurrentDispute((prev) => {
        if (!prev) {
          return {
            disputeId,
            escrowId: '',
            status: DISPUTE_STATUS.MEDIATORS_ASSIGNED,
            initiatorAddress: '',
            mediators,
            evidence: [],
            createdAt: new Date().toISOString(),
            assignedAt: incoming.assignedAt || new Date().toISOString(),
            finalizedAt: null,
            outcome: null,
            onChain: null,
            requestId: incoming.requestId || null,
            onChainTxHash: null,
            evidenceMerkleRoot: null
          };
        }
        return {
          ...prev,
          status: DISPUTE_STATUS.MEDIATORS_ASSIGNED,
          mediators,
          assignedAt: incoming.assignedAt || prev.assignedAt,
          requestId: incoming.requestId || prev.requestId
        };
      });
      toast.info('7 Mediators have been assigned via VRF!');
    };

    const handleEvidenceAdded = (payload) => {
      const evidence = payload && payload.evidence ? payload.evidence : payload;
      if (!evidence) return;

      setEvidenceList((prev) => {
        const exists = prev.find((e) => e.id === evidence.id);
        if (exists) return prev;
        return [...prev, evidence];
      });

      setCurrentDispute((prev) => {
        if (!prev) return prev;
        const exists = prev.evidence.find((e) => e.id === evidence.id);
        if (exists) return prev;
        return { ...prev, evidence: [...prev.evidence, evidence] };
      });
      toast.success('New evidence uploaded!');
    };

    const handleVoteSubmitted = (payload) => {
      const p = payload || {};
      const mediatorAddr = p.mediator;
      const voteChoice = p.vote;
      const votedAt = p.timestamp || new Date().toISOString();

      if (!mediatorAddr) return;

      setMediatorsList((prev) => {
        return prev.map((m) =>
          m.address === mediatorAddr
            ? { ...m, status: MEDIATOR_STATUS.VOTED, votedAt, voteChoice: voteChoice || m.voteChoice }
            : m
        );
      });

      setCurrentDispute((prev) => {
        if (!prev) return prev;
        const updatedMediators = prev.mediators.map((m) =>
          m.address === mediatorAddr
            ? { ...m, status: MEDIATOR_STATUS.VOTED, votedAt, voteChoice: voteChoice || m.voteChoice }
            : m
        );
        return { ...prev, mediators: updatedMediators };
      });
    };

    const handleVoteProgress = (payload) => {
      const incoming = payload || {};
      const base = incoming.tally || {};

      setVoteTally({
        RELEASE: Number(base.RELEASE || 0),
        REFUND: Number(base.REFUND || 0),
        SPLIT: Number(base.SPLIT || 0),
        OTHER: Number(base.OTHER || 0),
        totalVotes: Number(incoming.totalVotes ?? 0),
        threshold: Number(incoming.threshold ?? 4)
      });

      setCurrentDispute((prev) => {
        if (!prev) return prev;
        if (prev.status !== DISPUTE_STATUS.VOTING) return { ...prev, status: DISPUTE_STATUS.VOTING };
        return prev;
      });
      toast.info('A mediator has cast their vote.');
    };

    const handleDisputeResolved = (payload) => {
      const p = payload || {};
      setCurrentDispute((prev) => {
        if (!prev) {
          return {
            disputeId,
            escrowId: '',
            status: DISPUTE_STATUS.RESOLVED,
            initiatorAddress: '',
            mediators: [],
            evidence: [],
            createdAt: new Date().toISOString(),
            assignedAt: null,
            finalizedAt: p.finalizedAt || new Date().toISOString(),
            outcome: p.outcome || null,
            onChain: {
              events: [
                {
                  name: 'DisputeResolved',
                  txHash: p.onChainTxHash || null,
                  timestamp: p.finalizedAt || new Date().toISOString()
                }
              ]
            },
            requestId: null,
            onChainTxHash: p.onChainTxHash || null,
            evidenceMerkleRoot: null
          };
        }
        return {
          ...prev,
          status: DISPUTE_STATUS.RESOLVED,
          outcome: p.outcome || prev.outcome,
          finalizedAt: p.finalizedAt || prev.finalizedAt,
          onChain: {
            ...(prev.onChain || {}),
            events: [
              ...(prev.onChain?.events || []),
              {
                name: 'DisputeResolved',
                txHash: p.onChainTxHash || null,
                timestamp: p.finalizedAt || new Date().toISOString()
              }
            ]
          },
          onChainTxHash: p.onChainTxHash || prev.onChainTxHash
        };
      });

      if (Array.isArray(p.resolvingMediators) && p.resolvingMediators.length > 0) {
        setMediatorsList((prev) =>
          prev.map((m) =>
            p.resolvingMediators.includes(m.address)
              ? { ...m, status: MEDIATOR_STATUS.VOTED, votedAt: new Date().toISOString() }
              : m
          )
        );
      }
      toast.success('Dispute resolved! Threshold reached.');
    };

    const handleExecutionTriggered = (payload) => {
      const p = payload || {};
      setCurrentDispute((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          executionStatus: 'TRIGGERED',
          executionError: null,
          executionMethod: p.method || prev.executionMethod || null,
          executionStartedAt: p.startedAt || p.triggeredAt || new Date().toISOString()
        };
      });
      toast.info('Execution started: collecting TSS shares.');
    };

    const handleExecutionCompleted = (payload) => {
      const p = payload || {};
      setCurrentDispute((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          executionStatus: 'COMPLETED',
          executionError: null,
          onChainTxHash: p.txHash || p.onChainTxHash || prev.onChainTxHash || null,
          executedAt: p.executedAt || new Date().toISOString(),
          onChain: {
            ...(prev.onChain || {}),
            events: [
              ...(prev.onChain?.events || []),
              {
                name: 'ExecutionCompleted',
                txHash: p.txHash || p.onChainTxHash || null,
                blockNumber: p.blockNumber || null,
                timestamp: p.executedAt || new Date().toISOString()
              }
            ]
          }
        };
      });
      toast.success('Execution completed on-chain.');
    };

    const handleExecutionFailed = (payload) => {
      const p = payload || {};
      setCurrentDispute((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          executionStatus: 'FAILED',
          executionError: p.error || 'Execution failed',
          executionFailedAt: p.failedAt || new Date().toISOString()
        };
      });
      toast.error(`Execution failed: ${p.error || 'unknown error'}`);
    };

    const handleTssNeeded = (payload) => {
      console.log('📡 [SOCKET] Yêu cầu ký TSS Thực thi On-chain:', payload);
      toast.info('Tranh chấp đã có kết quả! Vui lòng thực hiện ký TSS để giải ngân.');
      setCurrentDispute(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          status: 'RESOLVED',
          tssNeeded: true,
          tssAction: payload.tssAction,
          escrowIdForTss: payload.escrowId
        };
      });
    };

    // BẢN VÁ: Hàm gom sự kiện ẩn danh thành hàm định danh để Cleanup có thể gỡ bỏ
    const handleSocketMessage = (ev) => {
      try {
        const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        const evt = msg.event;
        const payload = msg.payload;
        switch (evt) {
          case 'dispute-created': return handleDisputeCreated(payload);
          case 'mediator-assigned': return handleMediatorsAssigned(payload);
          case 'dispute-evidence-added': return handleEvidenceAdded(payload);
          case 'vote-submitted': return handleVoteSubmitted(payload);
          case 'vote-tally-updated': return handleVoteProgress(payload);
          case 'dispute-finalized': return handleDisputeResolved(payload);
          case 'execution-triggered': return handleExecutionTriggered(payload);
          case 'execution-completed': return handleExecutionCompleted(payload);
          case 'execution-failed': return handleExecutionFailed(payload);
          default: break;
        }
      } catch (err) {
        console.warn('useDisputeWebSocket: message parse error:', err);
      }
    };

    try {
      if (typeof socket.on === 'function') {
        socket.on('dispute-created', handleDisputeCreated);
        socket.on('mediator-assigned', handleMediatorsAssigned);
        socket.on('dispute-evidence-added', handleEvidenceAdded);
        socket.on('vote-submitted', handleVoteSubmitted);
        socket.on('vote-tally-updated', handleVoteProgress);
        socket.on('dispute-finalized', handleDisputeResolved);
        socket.on('execution-triggered', handleExecutionTriggered);
        socket.on('execution-completed', handleExecutionCompleted);
        socket.on('execution-failed', handleExecutionFailed);
        socket.on('dispute_tss_needed', handleTssNeeded);
      } else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('message', handleSocketMessage);
      }
    } catch (err) {
      console.warn('useDisputeWebSocket: listener registration error:', err);
    }

    // CLEANUP TRỌN VẸN
    return () => {
      try {
        if (typeof socket.off === 'function') {
          socket.off('dispute-created', handleDisputeCreated);
          socket.off('mediator-assigned', handleMediatorsAssigned);
          socket.off('dispute-evidence-added', handleEvidenceAdded);
          socket.off('vote-submitted', handleVoteSubmitted);
          socket.off('vote-tally-updated', handleVoteProgress);
          socket.off('dispute-finalized', handleDisputeResolved);
          socket.off('execution-triggered', handleExecutionTriggered);
          socket.off('execution-completed', handleExecutionCompleted);
          socket.off('execution-failed', handleExecutionFailed);
          socket.off('dispute_tss_needed', handleTssNeeded);
        } else if (typeof socket.removeEventListener === 'function') {
          socket.removeEventListener('message', handleSocketMessage);
        }

        if (typeof socket.emit === 'function') {
          socket.emit('unsubscribe', { channel: `dispute:${disputeId}` });
        }
      } catch (err) {
        console.warn('useDisputeWebSocket: cleanup error:', err);
      }
    };

  }, [disputeId, setCurrentDispute, setEvidenceList, setMediatorsList, setVoteTally]);
}
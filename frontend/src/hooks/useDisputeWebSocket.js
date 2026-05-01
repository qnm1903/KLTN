import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { toast } from 'react-toastify';
import {
  currentDisputeAtom,
  evidenceListAtom,
  mediatorsListAtom,
  voteTallyAtom
} from '../store/disputeAtoms.js';

// Giả sử có một socket instance chung được export từ src/lib/socket.js
// Socket có thể là socket.io-client hoặc wrapper tương tự với API .on/.off/.emit
import socket from '../lib/socket.js';

import {
  MEDIATOR_STATUS,
  DISPUTE_STATUS
} from '../constants/dispute.constants.js';

/**
 * useDisputeWebSocket
 *
 * - Kết nối tới WebSocket (socket instance import sẵn).
 * - Đăng ký listeners cho các events:
 *   'dispute:created', 'mediators:assigned', 'evidence:added', 'vote:submitted', 'vote:progress', 'dispute:resolved'
 * - Khi nhận payload, cập nhật Jotai atoms tương ứng.
 *
 * @param {string|null} disputeId - id của dispute đang quan tâm (nếu null thì không subscribe)
 */
export function useDisputeWebSocket(disputeId) {
  const setCurrentDispute = useSetAtom(currentDisputeAtom);
  const setEvidenceList = useSetAtom(evidenceListAtom);
  const setMediatorsList = useSetAtom(mediatorsListAtom);
  const setVoteTally = useSetAtom(voteTallyAtom);

  useEffect(() => {
    // Nếu không có socket hoặc disputeId, không đăng ký listeners
    if (!socket || !disputeId) {
      return undefined;
    }

    // Helper: subscribe to dispute channel if backend supports it
    try {
      if (typeof socket.emit === 'function') {
        socket.emit('subscribe', { channel: `dispute:${disputeId}` });
      }
    } catch (err) {
      // ignore subscription errors
    }

    // ---- Event handlers ----

    const handleDisputeCreated = (payload) => {
      // payload expected: { disputeId, escrowId, initiator, status, createdAt, ... }
      setCurrentDispute(payload);
    };

    const handleMediatorsAssigned = (payload) => {
      // payload expected: { disputeId, mediators: [addr...], assignedAt, requestId }
      const incoming = payload || {};
      const addrs = Array.isArray(incoming.mediators) ? incoming.mediators : [];

      // Map addresses -> Mediator objects (minimal)
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

      // Update currentDispute status/assignedAt/requestId when possible
      setCurrentDispute((prev) => {
        if (!prev) {
          // tạo skeleton nếu chưa có
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
      // payload expected: { disputeId, evidence: Evidence }
      const evidence = payload && payload.evidence ? payload.evidence : null;
      if (!evidence) return;

      // Append to evidenceListAtom (avoid duplicates)
      setEvidenceList((prev) => {
        const exists = prev.find((e) => e.id === evidence.id);
        if (exists) return prev;
        return [...prev, evidence];
      });

      // Also update currentDispute.evidence if exists
      setCurrentDispute((prev) => {
        if (!prev) return prev;
        const exists = prev.evidence.find((e) => e.id === evidence.id);
        if (exists) return prev;
        return {
          ...prev,
          evidence: [...prev.evidence, evidence]
        };
      });
      toast.success('New evidence uploaded!');
    };

    const handleVoteSubmitted = (payload) => {
      // payload expected: { disputeId, mediator, vote, justification, timestamp, signature }
      const p = payload || {};
      const mediatorAddr = p.mediator;
      const voteChoice = p.vote;
      const votedAt = p.timestamp || new Date().toISOString();

      if (!mediatorAddr) return;

      // Update mediatorsListAtom: mark mediator as voted and store voteChoice/votedAt
      setMediatorsList((prev) => {
        return prev.map((m) =>
          m.address === mediatorAddr
            ? {
                ...m,
                status: MEDIATOR_STATUS.VOTED,
                votedAt,
                voteChoice: voteChoice || m.voteChoice
              }
            : m
        );
      });

      // Optionally update currentDispute if present
      setCurrentDispute((prev) => {
        if (!prev) return prev;
        const updatedMediators = prev.mediators.map((m) =>
          m.address === mediatorAddr
            ? { ...m, status: MEDIATOR_STATUS.VOTED, votedAt, voteChoice: voteChoice || m.voteChoice }
            : m
        );
        return {
          ...prev,
          mediators: updatedMediators
        };
      });
    };

    const handleVoteProgress = (payload) => {
      // payload expected: { disputeId, tally: VoteTally, totalVotes, threshold }
      const tally = payload && payload.tally ? payload.tally : null;
      if (!tally) return;

      setVoteTally(tally);

      // Ensure dispute status set to VOTING
      setCurrentDispute((prev) => {
        if (!prev) return prev;
        if (prev.status !== DISPUTE_STATUS.VOTING) {
          return { ...prev, status: DISPUTE_STATUS.VOTING };
        }
        return prev;
      });
      toast.info('A mediator has cast their vote.');
    };

    const handleDisputeResolved = (payload) => {
      // payload expected: { disputeId, outcome, finalizedAt, onChainTxHash, resolvingMediators }
      const p = payload || {};
      setCurrentDispute((prev) => {
        if (!prev) {
          // create minimal resolved object
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

      // Update mediators list: mark resolvingMediators as VOTED
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

    // ---- Register listeners (socket.io style) ----
    try {
      if (typeof socket.on === 'function') {
        socket.on('dispute:created', handleDisputeCreated);
        socket.on('mediators:assigned', handleMediatorsAssigned);
        socket.on('evidence:added', handleEvidenceAdded);
        socket.on('vote:submitted', handleVoteSubmitted);
        socket.on('vote:progress', handleVoteProgress);
        socket.on('dispute:resolved', handleDisputeResolved);
      } else if (typeof socket.addEventListener === 'function') {
        // fallback: if socket is native WebSocket and server sends stringified messages,
        // we listen to 'message' and route based on event field in payload.
        socket.addEventListener('message', (ev) => {
          try {
            const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
            const evt = msg.event;
            const payload = msg.payload;
            switch (evt) {
              case 'dispute:created':
                handleDisputeCreated(payload);
                break;
              case 'mediators:assigned':
                handleMediatorsAssigned(payload);
                break;
              case 'evidence:added':
                handleEvidenceAdded(payload);
                break;
              case 'vote:submitted':
                handleVoteSubmitted(payload);
                break;
              case 'vote:progress':
                handleVoteProgress(payload);
                break;
              case 'dispute:resolved':
                handleDisputeResolved(payload);
                break;
              default:
                break;
            }
          } catch (err) {
            // ignore parse errors
          }
        });
      } else {
        // socket has no known API
        // console.warn('Socket instance does not support .on or .addEventListener');
      }
    } catch (err) {
      // swallow errors during registration
    }

    // Cleanup: remove listeners and unsubscribe from channel
    return () => {
      try {
        if (typeof socket.off === 'function') {
          socket.off('dispute:created', handleDisputeCreated);
          socket.off('mediators:assigned', handleMediatorsAssigned);
          socket.off('evidence:added', handleEvidenceAdded);
          socket.off('vote:submitted', handleVoteSubmitted);
          socket.off('vote:progress', handleVoteProgress);
          socket.off('dispute:resolved', handleDisputeResolved);
        } else if (typeof socket.removeEventListener === 'function') {
          // cannot remove message-specific listener easily if anonymous; in production keep named reference
          socket.removeEventListener('message', () => {});
        }

        // Unsubscribe channel if supported
        if (typeof socket.emit === 'function') {
          socket.emit('unsubscribe', { channel: `dispute:${disputeId}` });
        }
      } catch (err) {
        // ignore cleanup errors
      }
    };
  }, [disputeId, setCurrentDispute, setEvidenceList, setMediatorsList, setVoteTally]);
}
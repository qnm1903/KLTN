import express from 'express';
import prisma from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { verifyEIP712Signature } from '../crypto/eip712-verify.js';
import {
  ACCEPT_MEDIATOR_TYPE,
  EVIDENCE_META_TYPE,
  VOTE_TYPE,
  buildDisputeDomain
} from '../types/dispute-typed-data.js';
import {
  DISPUTE_EVENT_TYPES,
  queueDisputeEvent
} from '../lib/dispute-outbox.js';
import { finalizeDisputeVotes } from '../services/dispute-finalize.js';

const router = express.Router();

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function parseNonce(rawNonce) {
  const value = Number(rawNonce);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Invalid nonce in signed message');
  }
  return value;
}

function assertMessageObject(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('message must be an object');
  }
}

function assertDeadlineNotExpired(rawDeadline) {
  const deadline = Number(rawDeadline);
  if (!Number.isFinite(deadline)) {
    throw new Error('Invalid deadline in signed message');
  }
  const now = Math.floor(Date.now() / 1000);
  if (deadline < now) {
    throw new Error('Signed message has expired');
  }
}

async function consumeMediatorNonce(tx, address, rawNonce) {
  const nonce = parseNonce(rawNonce);
  const normalizedAddress = normalizeAddress(address);

  const nonceRow = await tx.mediatorNonce.upsert({
    where: { address: normalizedAddress },
    create: { address: normalizedAddress, currentNonce: 0 },
    update: {},
    select: { currentNonce: true }
  });

  if (nonceRow.currentNonce !== nonce) {
    throw new Error('Invalid nonce. Please refresh and sign again');
  }

  await tx.mediatorNonce.update({
    where: { address: normalizedAddress },
    data: { currentNonce: { increment: 1 } }
  });
}

function isEscrowParticipant(escrow, userId) {
  if (!escrow) return false;
  if (escrow.buyerId === userId || escrow.sellerId === userId) return true;
  return Array.isArray(escrow.escrowMediators) && escrow.escrowMediators.some((m) => m.mediatorId === userId);
}

async function getDisputeWithAccess(disputeId, userId) {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      escrow: {
        select: {
          id: true,
          buyerId: true,
          sellerId: true,
          escrowMediators: { select: { mediatorId: true } }
        }
      },
      mediators: {
        include: {
          mediator: { select: { id: true, walletAddress: true, name: true } }
        },
        orderBy: { createdAt: 'asc' }
      },
      votes: { orderBy: { votedAt: 'asc' } }
    }
  });

  if (!dispute) return { error: 'Dispute not found', code: 404 };
  if (!isEscrowParticipant(dispute.escrow, userId)) return { error: 'Forbidden', code: 403 };

  return { dispute };
}

function buildMediatorResponse(mediator) {
  return {
    address: normalizeAddress(mediator.mediator?.walletAddress || mediator.mediatorId),
    status: mediator.status,
    acceptedAt: mediator.acceptedAt?.toISOString() || null,
    declinedAt: mediator.declinedAt?.toISOString() || null,
    votedAt: mediator.votedAt?.toISOString() || null,
    voteChoice: null,
    score: null,
    note: null
  };
}

function buildEvidenceResponse(evidence) {
  return {
    id: evidence.id,
    ipfsHash: evidence.fileUrl || 'ipfs://unknown',
    uploader: normalizeAddress(evidence.uploader?.walletAddress || 'unknown'),
    description: evidence.description || '',
    metadata: {
      mime: 'application/octet-stream',
      size: 0,
      name: evidence.id
    },
    uploadedAt: evidence.createdAt?.toISOString() || null,
    confidential: false,
    signature: evidence.signature || null
  };
}

function buildDisputeDetailResponse(dispute, evidences = []) {
  return {
    disputeId: dispute.id,
    escrowId: dispute.escrowId,
    status: dispute.status,
    initiatorAddress: normalizeAddress(dispute.initiatorAddress),
    mediators: (dispute.mediators || []).map(buildMediatorResponse),
    evidence: (evidences || []).map(buildEvidenceResponse),
    createdAt: dispute.createdAt?.toISOString() || null,
    assignedAt: dispute.assignedAt?.toISOString() || null,
    finalizedAt: dispute.finalizedAt?.toISOString() || null,
    outcome: dispute.outcome || null,
    onChain: {
      disputeContract: null,
      disputeIndex: null,
      events: []
    },
    requestId: dispute.requestId || null,
    onChainTxHash: dispute.onChainTxHash || null,
    evidenceMerkleRoot: null
  };
}

function buildCreateDisputeResponse(dispute) {
  return {
    disputeId: dispute.id,
    status: dispute.status,
    requestId: dispute.requestId || null,
    onChainTxHash: dispute.onChainTxHash || null,
    createdAt: dispute.createdAt
  };
}

function buildVoteResponse(finalizeResult) {
  const tally = finalizeResult?.tally || {};
  const totalVotes = Object.values(tally).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    status: 'ACCEPTED',
    currentTally: {
      ...tally,
      totalVotes,
      threshold: finalizeResult?.threshold ?? null
    }
  };
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { escrowId, reason, description } = req.body;
    if (!escrowId || !reason) {
      return res.status(400).json({ error: 'escrowId and reason are required' });
    }

    const escrow = await prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { escrowMediators: { orderBy: { slot: 'asc' } } }
    });

    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });
    if (!isEscrowParticipant(escrow, req.user.id)) {
      return res.status(403).json({ error: 'Only escrow participants can create disputes' });
    }

    const existingActiveDispute = await prisma.dispute.findFirst({
      where: {
        escrowId,
        status: { not: 'RESOLVED' }
      },
      select: { id: true, status: true }
    });
    if (existingActiveDispute) {
      return res.status(409).json({
        error: 'This escrow already has an active dispute',
        disputeId: existingActiveDispute.id,
        status: existingActiveDispute.status
      });
    }

    const dispute = await prisma.$transaction(async (tx) => {
      const created = await tx.dispute.create({
        data: {
          escrowId,
          initiatorAddress: normalizeAddress(req.user.walletAddress),
          reason,
          description: description || '',
          status: 'MEDIATORS_ASSIGNED',
          assignedAt: new Date(),
          mediators: {
            create: escrow.escrowMediators.map((row) => ({
              mediatorId: row.mediatorId,
              slot: row.slot,
              status: 'assigned'
            }))
          }
        },
        include: {
          mediators: true
        }
      });

      await queueDisputeEvent(tx, {
        disputeId: created.id,
        escrowId,
        type: DISPUTE_EVENT_TYPES.DISPUTE_CREATED,
        payload: { disputeId: created.id, escrowId, status: created.status }
      });

      for (const mediator of created.mediators) {
        await queueDisputeEvent(tx, {
          disputeId: created.id,
          escrowId,
          type: DISPUTE_EVENT_TYPES.MEDIATOR_ASSIGNED,
          payload: {
            disputeId: created.id,
            escrowId,
            mediatorId: mediator.mediatorId,
            slot: mediator.slot,
            status: mediator.status
          }
        });
      }

      return created;
    });

    res.status(201).json(buildCreateDisputeResponse(dispute));
  } catch (error) {
    console.error('Error in POST /disputes:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const disputes = await prisma.dispute.findMany({
      where: {
        OR: [
          { escrow: { buyerId: req.user.id } },
          { escrow: { sellerId: req.user.id } },
          { mediators: { some: { mediatorId: req.user.id } } }
        ]
      },
      include: {
        escrow: { select: { id: true, title: true } },
        _count: { select: { votes: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(disputes);
  } catch (error) {
    console.error('Error in GET /disputes:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const access = await getDisputeWithAccess(req.params.id, req.user.id);
    if (access.error) return res.status(access.code).json({ error: access.error });
    
    const evidences = await prisma.evidence.findMany({
      where: { escrowId: access.dispute.escrowId },
      include: { uploader: { select: { walletAddress: true } } },
      orderBy: { createdAt: 'asc' }
    });
    
    res.json(buildDisputeDetailResponse(access.dispute, evidences));
  } catch (error) {
    console.error('Error in GET /disputes/:id:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/mediators', authMiddleware, async (req, res) => {
  try {
    const access = await getDisputeWithAccess(req.params.id, req.user.id);
    if (access.error) return res.status(access.code).json({ error: access.error });
    res.json(access.dispute.mediators);
  } catch (error) {
    console.error('Error in GET /disputes/:id/mediators:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/accept-mediator', authMiddleware, async (req, res) => {
  try {
    const { decision, signature, message } = req.body;
    if (!decision || !signature || !message) {
      return res.status(400).json({ error: 'decision, signature, and message are required' });
    }
    assertMessageObject(message);

    const mediatorLink = await prisma.disputeMediator.findUnique({
      where: { disputeId_mediatorId: { disputeId: req.params.id, mediatorId: req.user.id } },
      include: { dispute: { select: { escrowId: true } } }
    });
    if (!mediatorLink) return res.status(403).json({ error: 'You are not assigned to this dispute' });

    const normalizedDecision = String(decision).toLowerCase();
    if (normalizedDecision !== 'accept' && normalizedDecision !== 'decline') {
      return res.status(400).json({ error: 'decision must be either accept or decline' });
    }
    if (String(message.disputeId) !== req.params.id || String(message.escrowId) !== mediatorLink.dispute.escrowId) {
      return res.status(400).json({ error: 'Signed message does not match dispute context' });
    }
    if (normalizeAddress(message.mediator) !== normalizeAddress(req.user.walletAddress)) {
      return res.status(400).json({ error: 'Signed mediator address mismatch' });
    }
    if (String(message.decision || '').toLowerCase() !== normalizedDecision) {
      return res.status(400).json({ error: 'Signed decision does not match request decision' });
    }
    assertDeadlineNotExpired(message.deadline);

    const check = verifyEIP712Signature({
      domain: buildDisputeDomain(),
      types: ACCEPT_MEDIATOR_TYPE,
      primaryType: 'AcceptMediator',
      message,
      signature,
      expectedSigner: req.user.walletAddress
    });
    if (!check.valid) return res.status(400).json({ error: 'Invalid EIP-712 signature' });

    const status = normalizedDecision === 'accept' ? 'accepted' : 'declined';
    const updated = await prisma.$transaction(async (tx) => {
      await consumeMediatorNonce(tx, req.user.walletAddress, message.nonce);
      const result = await tx.disputeMediator.update({
        where: { disputeId_mediatorId: { disputeId: req.params.id, mediatorId: req.user.id } },
        data: {
          status,
          acceptedAt: status === 'accepted' ? new Date() : null,
          declinedAt: status === 'declined' ? new Date() : null,
          signature,
          messageRaw: message,
          nonce: parseNonce(message.nonce)
        }
      });

      await queueDisputeEvent(tx, {
        disputeId: req.params.id,
        escrowId: mediatorLink.dispute.escrowId,
        type: status === 'accepted' ? DISPUTE_EVENT_TYPES.MEDIATOR_ACCEPTED : DISPUTE_EVENT_TYPES.MEDIATOR_DECLINED,
        payload: {
          disputeId: req.params.id,
          escrowId: mediatorLink.dispute.escrowId,
          mediatorId: req.user.id,
          status,
          decision: normalizedDecision
        }
      });

      return result;
    });

    res.json(updated);
  } catch (error) {
    if (error.message?.includes('Invalid nonce') || error.message?.includes('Signed message has expired')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error in POST /disputes/:id/accept-mediator:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/vote', authMiddleware, async (req, res) => {
  try {
    const { vote, justification, evidenceRefs, signature, message } = req.body;
    if (!vote || !signature || !message) {
      return res.status(400).json({ error: 'vote, signature, and message are required' });
    }
    assertMessageObject(message);

    const mediatorLink = await prisma.disputeMediator.findUnique({
      where: { disputeId_mediatorId: { disputeId: req.params.id, mediatorId: req.user.id } },
      include: { dispute: { select: { id: true, escrowId: true, status: true } } }
    });
    if (!mediatorLink) return res.status(403).json({ error: 'You are not assigned to this dispute' });
    if (mediatorLink.status !== 'accepted') {
      return res.status(403).json({ error: 'Mediator must accept assignment before voting' });
    }
    if (!['MEDIATORS_ASSIGNED', 'VOTING'].includes(mediatorLink.dispute.status)) {
      return res.status(409).json({ error: `Dispute is not in votable state: ${mediatorLink.dispute.status}` });
    }

    if (String(message.disputeId) !== req.params.id || String(message.escrowId) !== mediatorLink.dispute.escrowId) {
      return res.status(400).json({ error: 'Signed message does not match dispute context' });
    }
    if (String(message.vote) !== String(vote)) {
      return res.status(400).json({ error: 'Signed vote does not match request vote' });
    }
    assertDeadlineNotExpired(message.deadline);

    const check = verifyEIP712Signature({
      domain: buildDisputeDomain(),
      types: VOTE_TYPE,
      primaryType: 'Vote',
      message,
      signature,
      expectedSigner: req.user.walletAddress
    });
    if (!check.valid) return res.status(400).json({ error: 'Invalid EIP-712 signature' });

    const createdVote = await prisma.$transaction(async (tx) => {
      await consumeMediatorNonce(tx, req.user.walletAddress, message.nonce);
      const insertedVote = await tx.disputeVote.create({
        data: {
          disputeId: req.params.id,
          mediatorId: req.user.id,
          vote,
          justification: justification || '',
          evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
          signature,
          messageRaw: message
        }
      });

      await tx.disputeMediator.update({
        where: { disputeId_mediatorId: { disputeId: req.params.id, mediatorId: req.user.id } },
        data: {
          status: 'voted',
          votedAt: new Date(),
          signature,
          messageRaw: message,
          nonce: parseNonce(message.nonce)
        }
      });

      await queueDisputeEvent(tx, {
        disputeId: req.params.id,
        escrowId: mediatorLink.dispute.escrowId,
        type: DISPUTE_EVENT_TYPES.VOTE_SUBMITTED,
        payload: {
          disputeId: req.params.id,
          escrowId: mediatorLink.dispute.escrowId,
          mediatorId: req.user.id,
          vote: insertedVote.vote,
          votedAt: insertedVote.votedAt
        }
      });

      return insertedVote;
    });

    const finalizeResult = await finalizeDisputeVotes(req.params.id);
    res.status(201).json(buildVoteResponse(finalizeResult));
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'Mediator already voted for this dispute' });
    if (error.message?.includes('Invalid nonce') || error.message?.includes('Signed message has expired')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error in POST /disputes/:id/vote:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/evidence/:evidenceId/signature', authMiddleware, async (req, res) => {
  try {
    const { signature, message } = req.body;
    if (!signature || !message) {
      return res.status(400).json({ error: 'signature and message are required' });
    }
    assertMessageObject(message);

    const access = await getDisputeWithAccess(req.params.id, req.user.id);
    if (access.error) return res.status(access.code).json({ error: access.error });

    const evidence = await prisma.evidence.findUnique({ where: { id: req.params.evidenceId } });
    if (!evidence || evidence.escrowId !== access.dispute.escrowId) {
      return res.status(404).json({ error: 'Evidence not found in dispute escrow' });
    }

    if (
      String(message.disputeId) !== req.params.id
      || String(message.escrowId) !== access.dispute.escrowId
      || String(message.evidenceId) !== req.params.evidenceId
    ) {
      return res.status(400).json({ error: 'Signed message does not match evidence context' });
    }
    assertDeadlineNotExpired(message.deadline);

    const check = verifyEIP712Signature({
      domain: buildDisputeDomain(),
      types: EVIDENCE_META_TYPE,
      primaryType: 'EvidenceMeta',
      message,
      signature,
      expectedSigner: req.user.walletAddress
    });
    if (!check.valid) return res.status(400).json({ error: 'Invalid EIP-712 signature' });

    const updatedEvidence = await prisma.$transaction(async (tx) => {
      await consumeMediatorNonce(tx, req.user.walletAddress, message.nonce);
      const updated = await tx.evidence.update({
        where: { id: req.params.evidenceId },
        data: { signature, messageRaw: message }
      });

      await queueDisputeEvent(tx, {
        disputeId: req.params.id,
        escrowId: access.dispute.escrowId,
        type: DISPUTE_EVENT_TYPES.EVIDENCE_SIGNED,
        payload: {
          disputeId: req.params.id,
          escrowId: access.dispute.escrowId,
          evidenceId: updated.id,
          signer: normalizeAddress(req.user.walletAddress)
        }
      });

      return updated;
    });

    res.json(updatedEvidence);
  } catch (error) {
    if (error.message?.includes('Invalid nonce') || error.message?.includes('Signed message has expired')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error in POST /disputes/:id/evidence/:evidenceId/signature:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/finalize', authMiddleware, async (req, res) => {
  try {
    const access = await getDisputeWithAccess(req.params.id, req.user.id);
    if (access.error) return res.status(access.code).json({ error: access.error });

    const result = await finalizeDisputeVotes(req.params.id);
    res.json({
      onChainTxHash: result?.onChainTxHash || null,
      finalizedAt: result?.finalizedAt || null
    });
  } catch (error) {
    console.error('Error in POST /disputes/:id/finalize:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/evidence', authMiddleware, async (req, res) => {
  try {
    const access = await getDisputeWithAccess(req.params.id, req.user.id);
    if (access.error) return res.status(access.code).json({ error: access.error });

    const evidences = await prisma.evidence.findMany({
      where: { escrowId: access.dispute.escrowId },
      include: { uploader: { select: { walletAddress: true } } },
      orderBy: { createdAt: 'asc' }
    });

    res.json(evidences.map(buildEvidenceResponse));
  } catch (error) {
    console.error('Error in GET /disputes/:id/evidence:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/evidence/:evidenceId/signature', authMiddleware, async (req, res) => {
  try {
    const { signature, message } = req.body;
    if (!signature || !message) {
      return res.status(400).json({ error: 'signature and message are required' });
    }
    assertMessageObject(message);

    const access = await getDisputeWithAccess(req.params.id, req.user.id);
    if (access.error) return res.status(access.code).json({ error: access.error });

    const evidence = await prisma.evidence.findUnique({ where: { id: req.params.evidenceId } });
    if (!evidence || evidence.escrowId !== access.dispute.escrowId) {
      return res.status(404).json({ error: 'Evidence not found in dispute escrow' });
    }

    if (
      String(message.disputeId) !== req.params.id
      || String(message.escrowId) !== access.dispute.escrowId
      || String(message.evidenceId) !== req.params.evidenceId
    ) {
      return res.status(400).json({ error: 'Signed message does not match evidence context' });
    }
    assertDeadlineNotExpired(message.deadline);

    const check = verifyEIP712Signature({
      domain: buildDisputeDomain(),
      types: EVIDENCE_META_TYPE,
      primaryType: 'EvidenceMeta',
      message,
      signature,
      expectedSigner: req.user.walletAddress
    });
    if (!check.valid) return res.status(400).json({ error: 'Invalid EIP-712 signature' });

    const updatedEvidence = await prisma.$transaction(async (tx) => {
      await consumeMediatorNonce(tx, req.user.walletAddress, message.nonce);
      const updated = await tx.evidence.update({
        where: { id: req.params.evidenceId },
        data: { signature, messageRaw: message },
        include: { uploader: { select: { walletAddress: true } } }
      });

      await queueDisputeEvent(tx, {
        disputeId: req.params.id,
        escrowId: access.dispute.escrowId,
        type: DISPUTE_EVENT_TYPES.EVIDENCE_SIGNED,
        payload: {
          disputeId: req.params.id,
          escrowId: access.dispute.escrowId,
          evidenceId: updated.id,
          signer: normalizeAddress(req.user.walletAddress)
        }
      });

      return updated;
    });

    res.json(buildEvidenceResponse(updatedEvidence));
  } catch (error) {
    if (error.message?.includes('Invalid nonce') || error.message?.includes('Signed message has expired')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error in POST /disputes/:id/evidence/:evidenceId/signature:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
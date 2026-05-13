import prisma from '../lib/prisma.js';
import { DISPUTE_EVENT_TYPES, queueDisputeEvent } from '../lib/dispute-outbox.js';
import { ethers } from 'ethers';
import { factoryAbi } from '../abi.js';

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const EXECUTION_MAX_RETRIES = 3;

/**
 * Execute dispute outcome on-chain via Schnorr TSS
 * 
 * Flow:
 * 1. Load dispute + escrow metadata
 * 2. Determine contract method (release or refund) based on outcome
 * 3. Trigger TSS session for 7 participants
 * 4. Collect nonces from all 7 participants (POST /disputes/:id/nonce)
 * 5. Aggregate nonces, compute challenge
 * 6. Collect z-shares from all 7 participants (POST /disputes/:id/sign)
 * 7. Aggregate z-shares, build final signature
 * 8. Execute contract call (vault.release() or vault.refund())
 * 9. Store onChainTxHash in dispute record
 * 
 * @param {string} disputeId - ID of the resolved dispute
 * @returns {Promise<Object>} - Execution result { executed: boolean, txHash?: string, error?: string }
 */
export async function executeDisputeOutcome(disputeId) {
  return prisma.$transaction(async (tx) => {
    // 1. Load dispute + escrow
    const dispute = await tx.dispute.findUnique({
      where: { id: disputeId },
      include: {
        escrow: {
          select: {
            id: true,
            contractAddress: true,
            buyerId: true,
            sellerId: true,
            escrowMediators: {
              select: { mediatorId: true, slot: true, mediator: { select: { walletAddress: true } } },
              orderBy: { slot: 'asc' }
            },
            buyer: { select: { walletAddress: true } },
            seller: { select: { walletAddress: true } }
          }
        }
      }
    });

    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    if (dispute.status !== 'RESOLVED' || !dispute.outcome) {
      throw new Error(`Dispute ${disputeId} is not resolved or has no outcome`);
    }

    if (dispute.onChainTxHash) {
      return {
        executed: false,
        reason: 'Dispute already executed',
        txHash: dispute.onChainTxHash
      };
    }

    const escrow = dispute.escrow;
    if (!escrow?.contractAddress) {
      throw new Error(`Escrow ${escrow?.id || 'unknown'} has no contract address`);
    }

    // 2. Determine contract method
    const method = dispute.outcome === 'RELEASE_TO_BUYER' ? 'release' : 'refund';

    // 3. Queue event to trigger TSS collection phase
    await queueDisputeEvent(tx, {
      disputeId: dispute.id,
      escrowId: escrow.id,
      type: DISPUTE_EVENT_TYPES.EXECUTION_TRIGGERED,
      payload: {
        disputeId: dispute.id,
        escrowId: escrow.id,
        outcome: dispute.outcome,
        method,
        contractAddress: escrow.contractAddress,
        requiredParticipants: 7,
        threshold: 5,
        status: 'AWAITING_TSS_SHARES'
      }
    });

    // 4-9. TSS collection + execution happens in separate phase
    // Return pending status while waiting for TSS shares
    return {
      executed: false,
      status: 'PENDING_TSS_COLLECTION',
      disputeId: dispute.id,
      escrowId: escrow.id,
      outcome: dispute.outcome,
      method
    };
  });
}

/**
 * Complete TSS-signed execution after all shares collected
 * Called after POST /disputes/:id/nonce + POST /disputes/:id/sign collect all shares
 * 
 * @param {string} disputeId - ID of the dispute
 * @param {Object} context - TSS aggregation context { aggregatedSignature, signerBitmap, ... }
 * @returns {Promise<Object>} - { executed: boolean, txHash?: string }
 */
export async function completeDisputeExecution(disputeId, context = {}) {
  return prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({
      where: { id: disputeId },
      include: { escrow: { select: { id: true, contractAddress: true } } }
    });

    if (!dispute) throw new Error(`Dispute ${disputeId} not found`);
    if (dispute.onChainTxHash) {
      return { executed: false, reason: 'Already executed', txHash: dispute.onChainTxHash };
    }

    const { aggregatedSignature, signerBitmap } = context;
    if (!aggregatedSignature) {
      throw new Error('Missing aggregated signature in execution context');
    }

    // Execute on-chain transaction
    try {
      const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
      const signer = new ethers.Wallet(process.env.DISPUTE_EXECUTOR_PRIVATE_KEY || '', provider);

      const vault = new ethers.Contract(
        dispute.escrow.contractAddress,
        ['function release(bytes calldata sig, bytes calldata bitmap) external', 'function refund(bytes calldata sig, bytes calldata bitmap) external'],
        signer
      );

      const method = dispute.outcome === 'RELEASE_TO_BUYER' ? 'release' : 'refund';
      const txResponse = await vault[method](aggregatedSignature, signerBitmap);
      const receipt = await txResponse.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction failed or reverted');
      }

      // Update dispute with execution result
      const updated = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: 'EXECUTED',
          onChainTxHash: receipt.transactionHash,
          executedAt: new Date()
        }
      });

      await queueDisputeEvent(tx, {
        disputeId: updated.id,
        escrowId: dispute.escrow.id,
        type: DISPUTE_EVENT_TYPES.EXECUTION_COMPLETED,
        payload: {
          disputeId: updated.id,
          escrowId: dispute.escrow.id,
          outcome: dispute.outcome,
          txHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          executedAt: updated.executedAt
        }
      });

      return {
        executed: true,
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber
      };
    } catch (error) {
      await queueDisputeEvent(tx, {
        disputeId,
        escrowId: dispute.escrow.id,
        type: DISPUTE_EVENT_TYPES.EXECUTION_FAILED,
        payload: {
          disputeId,
          escrowId: dispute.escrow.id,
          error: error.message,
          failedAt: new Date()
        }
      });

      throw new Error(`Execution failed: ${error.message}`);
    }
  });
}

/**
 * Retry execution for disputes stuck in RESOLVED state
 * Called by cron job in phase 4
 * 
 * @returns {Promise<Object>} - { retried: number, failed: number }
 */
export async function retryStuckExecutions() {
  const stuck = await prisma.dispute.findMany({
    where: {
      status: 'RESOLVED',
      onChainTxHash: null,
      createdAt: {
        gt: new Date(Date.now() - 24 * 60 * 60 * 1000) // Within last 24 hours
      }
    },
    take: 10
  });

  let retried = 0;
  let failed = 0;

  for (const dispute of stuck) {
    try {
      const result = await executeDisputeOutcome(dispute.id);
      if (result.status === 'PENDING_TSS_COLLECTION') {
        retried += 1;
      }
    } catch (error) {
      console.error(`Failed to retry dispute ${dispute.id}:`, error.message);
      failed += 1;
    }
  }

  return { retried, failed, total: stuck.length };
}

export default {
  executeDisputeOutcome,
  completeDisputeExecution,
  retryStuckExecutions
};

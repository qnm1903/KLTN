import { ethers } from 'ethers';
import { vaultAbi, mediatorPoolAbi } from '../abi.js';

// On-chain Status enum: CREATED=0, LOCKED=1, RELEASED=2, REFUNDED=3, DISPUTED=4
const STATUS_LOCKED = 1n;
const STATUS_DISPUTED = 4n;
const STATUS_FINAL = new Set([2n, 3n]); // RELEASED | REFUNDED

/**
 * Tạo ví relayer ký giao dịch on-chain (dùng admin key đã cấu hình cho MediatorPool).
 * Trả null nếu thiếu cấu hình để caller bỏ qua một cách an toàn.
 */
function getRelayer(logger = console) {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    logger.warn?.('[timeout-exec] Missing RPC_URL or PRIVATE_KEY — skipping on-chain action');
    return null;
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return { provider, wallet: new ethers.Wallet(privateKey, provider) };
}

/**
 * Fallback relayer cho bước kích hoạt quá hạn: gọi vault.triggerTimeout() khi LOCKED quá hạn
 * mà chưa ai bấm nút trên FE. DB chuyển DISPUTED qua event DisputeOpened (event listener).
 * Idempotent: bỏ qua nếu trạng thái on-chain không còn là LOCKED.
 *
 * @returns {Promise<{triggered: boolean, txHash?: string, reason?: string}>}
 */
export async function triggerTimeoutOnChain(vaultAddress, { logger = console } = {}) {
  if (!vaultAddress) return { triggered: false, reason: 'missing_vault_address' };
  const relayer = getRelayer(logger);
  if (!relayer) return { triggered: false, reason: 'relayer_unconfigured' };

  const vault = new ethers.Contract(vaultAddress, vaultAbi, relayer.wallet);

  const currentStatus = BigInt(await vault.status());
  if (currentStatus !== STATUS_LOCKED) {
    // Đã có người bấm nút hoặc đã chuyển trạng thái khác — không cần làm gì.
    return { triggered: false, reason: 'not_locked' };
  }

  const tx = await vault.triggerTimeout();
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`triggerTimeout tx failed: ${tx.hash}`);
  }

  logger.info?.(`[timeout-exec] triggerTimeout() executed for vault=${vaultAddress} tx=${tx.hash}`);
  return { triggered: true, txHash: tx.hash };
}

/**
 * Bước 4 — hết hạn TRONG hòa giải: chia đôi tiền (timeoutSplit) + phạt các hòa giải viên
 * không bỏ phiếu (slashForTimeout, tiền phạt bù cho buyer/seller).
 * Escrow status sẽ tự chuyển RELEASED qua event FundsSplit; ở đây chỉ cập nhật bản ghi Dispute.
 *
 * @returns {Promise<{executed: boolean, txHash?: string, slashed?: string[], reason?: string}>}
 */
export async function executeMediationTimeout({ prisma, escrowId, logger = console }) {
  const relayer = getRelayer(logger);
  if (!relayer) return { executed: false, reason: 'relayer_unconfigured' };

  const escrow = await prisma.escrow.findUnique({
    where: { id: escrowId },
    select: {
      id: true,
      contractAddress: true,
      buyer: { select: { walletAddress: true } },
      seller: { select: { walletAddress: true } },
      disputes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          outcome: true,
          onChainTxHash: true,
          mediators: { select: { mediatorId: true, mediator: { select: { walletAddress: true } } } },
          votes: { select: { mediatorId: true } }
        }
      }
    }
  });

  if (!escrow?.contractAddress) return { executed: false, reason: 'no_contract_address' };
  const dispute = escrow.disputes?.[0] ?? null;
  if (dispute?.onChainTxHash) return { executed: false, reason: 'already_executed' };
  // Nếu hội đồng đã chốt được kết quả bằng bỏ phiếu thì đây không phải "hết hạn hòa giải" —
  // để luồng thực thi theo phán quyết xử lý, không tự chia đôi.
  if (dispute?.status === 'RESOLVED' && dispute?.outcome) {
    return { executed: false, reason: 'resolved_by_vote' };
  }

  const vault = new ethers.Contract(escrow.contractAddress, vaultAbi, relayer.wallet);
  const onChainStatus = BigInt(await vault.status());
  if (STATUS_FINAL.has(onChainStatus)) return { executed: false, reason: 'already_final' };
  if (onChainStatus !== STATUS_DISPUTED) return { executed: false, reason: 'not_disputed_on_chain' };

  // 1) Chia đôi tiền 50/50 (on-chain disputeDeadline 3 ngày chắc chắn đã qua tại mốc decision).
  const splitTx = await vault.timeoutSplit();
  const splitReceipt = await splitTx.wait();
  if (!splitReceipt || splitReceipt.status !== 1) {
    throw new Error(`timeoutSplit tx failed: ${splitTx.hash}`);
  }
  logger.info?.(`[timeout-exec] timeoutSplit() executed for escrow=${escrowId} tx=${splitTx.hash}`);

  // 2) Phạt hòa giải viên không bỏ phiếu (gây ra hết hạn hòa giải).
  const slashed = await slashNonVotingMediators({ relayer, dispute, escrow, logger });

  // 3) Cập nhật bản ghi Dispute (escrow status do event FundsSplit cập nhật).
  if (dispute?.id) {
    await prisma.dispute.update({
      where: { id: dispute.id },
      data: {
        status: 'TIMED_OUT',
        outcome: 'SPLIT',
        onChainTxHash: splitTx.hash,
        finalizedAt: new Date()
      }
    });
  }

  return { executed: true, txHash: splitTx.hash, slashed };
}

async function slashNonVotingMediators({ relayer, dispute, escrow, logger }) {
  const poolAddress = process.env.MEDIATOR_POOL_CONTRACT;
  if (!poolAddress || !dispute) return [];

  const votedIds = new Set((dispute.votes ?? []).map((v) => v.mediatorId));
  const offenders = (dispute.mediators ?? []).filter(
    (m) => !votedIds.has(m.mediatorId) && m.mediator?.walletAddress
  );
  if (offenders.length === 0) return [];

  const buyerAddr = escrow.buyer?.walletAddress;
  const sellerAddr = escrow.seller?.walletAddress;
  if (!buyerAddr || !sellerAddr) return [];

  const pool = new ethers.Contract(poolAddress, mediatorPoolAbi, relayer.wallet);
  const slashed = [];

  for (const offender of offenders) {
    const wallet = offender.mediator.walletAddress;
    try {
      const tx = await pool.slashForTimeout(wallet, buyerAddr, sellerAddr);
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        slashed.push(wallet);
        logger.info?.(`[timeout-exec] slashForTimeout mediator=${wallet} tx=${tx.hash}`);
      }
    } catch (error) {
      // MV có thể đã bị deactivate / không active — bỏ qua, không chặn các MV khác.
      logger.warn?.(`[timeout-exec] slashForTimeout failed for mediator=${wallet}: ${error.message}`);
    }
  }

  return slashed;
}

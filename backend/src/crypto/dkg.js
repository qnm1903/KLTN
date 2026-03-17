/**
 * DKG — Distributed Key Generation (No Trusted Dealer)
 *
 * Option 2 upgrade từ trusted dealer:
 *   - Mỗi bên (buyer, seller, mediator) tự sinh (s_i, PK_i) ở FRONTEND
 *   - Frontend gửi PUBLIC keys lên backend (không bao giờ private keys)
 *   - Backend tính 3 đôi PKagg cho 3 tổ hợp 2-of-3:
 *       PKagg_buyerSeller   = PK_buyer + PK_seller    -> dùng cho 'release'
 *       PKagg_buyerMediator = PK_buyer + PK_mediator  -> dùng cho 'refund'
 *       PKagg_sellerMediator = PK_seller + PK_mediator -> dùng cho 'timeout'
 *   - Backend không biết bất kỳ private key nào
 */

import { aggregatePublicKeys } from './schnorr.js';

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 phút

/**
 * Khởi tạo session DKG từ 3 public keys do frontend cung cấp.
 *
 * @param {string} escrowId
 * @param {{ buyerPubKey, sellerPubKey, mediatorPubKey }} pubKeys
 * @param {object} sessionStore
 * @returns {{ pkAgg_bs, pkAgg_bm, pkAgg_sm }}
 */
export function initDKG(escrowId, { buyerPubKey, sellerPubKey, mediatorPubKey }, sessionStore) {
  const pkAgg_bs = aggregatePublicKeys([buyerPubKey, sellerPubKey]);
  const pkAgg_bm = aggregatePublicKeys([buyerPubKey, mediatorPubKey]);
  const pkAgg_sm = aggregatePublicKeys([sellerPubKey, mediatorPubKey]);

  sessionStore.set(escrowId, {
    pubKeys: { buyer: buyerPubKey, seller: sellerPubKey, mediator: mediatorPubKey },
    pkAgg: {
      buyerSeller: pkAgg_bs,
      buyerMediator: pkAgg_bm,
      sellerMediator: pkAgg_sm
    },
    nonces: {},          // Round 1: { role: { R_x, R_y } }
    zShares: {},         // Round 2: { role: z_hex }
    signingRoles: null,  // 2 bên đang ký, set khi bắt đầu round 1
    signingAction: null,
    completedActions: [],
    createdAt: Date.now(),
    status: 'INITIALIZED'
  });

  return {
    pkAgg_bs: { x: pkAgg_bs.x, y: pkAgg_bs.y },
    pkAgg_bm: { x: pkAgg_bm.x, y: pkAgg_bm.y },
    pkAgg_sm: { x: pkAgg_sm.x, y: pkAgg_sm.y }
  };
}

/**
 * Lấy PKagg phù hợp cho 2 bên đang ký.
 */
export function getPkAggForRoles(session, roles) {
  const key = [...roles].sort().join('+');
  const map = {
    'buyer+seller':    session.pkAgg.buyerSeller,
    'buyer+mediator':  session.pkAgg.buyerMediator,
    'mediator+seller': session.pkAgg.sellerMediator
  };
  if (!map[key]) throw new Error(`No PKagg for role pair: ${key}`);
  return map[key];
}
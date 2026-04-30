import { atom } from 'jotai';
import { DISPUTE_THRESHOLD } from '../constants/dispute.constants.js';

/**
 * Atom lưu Dispute hiện tại (hoặc null nếu chưa có)
 * @type {import('jotai').Atom<import('../constants/dispute.constants.js').Dispute|null>}
 */
export const currentDisputeAtom = atom(null);

/**
 * Atom lưu array của Evidence (off-chain items, ví dụ IPFS refs)
 * @type {import('jotai').Atom<Array<import('../constants/dispute.constants.js').Evidence>>}
 */
export const evidenceListAtom = atom([]);

/**
 * Atom lưu array của Mediators (thường length = 7 khi assigned)
 * @type {import('jotai').Atom<Array<import('../constants/dispute.constants.js').Mediator>>}
 */
export const mediatorsListAtom = atom([]);

/**
 * Atom lưu VoteTally hiện tại
 * Khởi tạo với giá trị mặc định (0 counts) và threshold dựa trên DISPUTE_THRESHOLD
 * @type {import('jotai').Atom<import('../constants/dispute.constants.js').VoteTally>}
 */
export const voteTallyAtom = atom({
  RELEASE_TO_BUYER: 0,
  RETURN_TO_SELLER: 0,
  SPLIT: 0,
  OTHER: 0,
  totalVotes: 0,
  threshold: DISPUTE_THRESHOLD || 5
});
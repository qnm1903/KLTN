/**
 * useDkgPhase — Điều phối 4 bước Pedersen VSS DKG cho một party
 *
 * Bước 1: generatePolynomial → upload commitments + identity pubkey
 * Bước 2: evaluatePoly cho mọi party khác + ECDH encrypt → upload shares
 * Bước 3: fetch + decrypt + Feldman verify tất cả shares gửi đến mình
 * Bước 4: aggregate verified shares → signingKey (thay thế random key cũ)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { addSystemLogAtom } from './escrowStore';
import api from '../../lib/api';

// Mapping role → participantId cho Shamir (phải khớp với backend ROLE_TO_ID)
const ROLE_TO_ID = {
  buyer: 1,
  seller: 2,
  mediator1: 3,
  mediator2: 4,
  mediator3: 5,
  mediator4: 6,
  mediator5: 7,
};

const ALL_ROLES = Object.keys(ROLE_TO_ID);
const TOTAL_PARTIES = ALL_ROLES.length; // 7

// DKG phase states (trong order)
export const DKG_STATE = {
  IDLE: 'idle',
  GENERATING: 'generating',       // B1: sinh polynomial
  COMMITTED: 'committed',         // B1: đã upload commitments
  SHARES_SENT: 'shares_sent',     // B2: đã upload encrypted shares
  VERIFYING: 'verifying',         // B3: đang verify shares từ người khác
  VERIFIED: 'verified',           // B3: tất cả shares hợp lệ
  AGGREGATING: 'aggregating',     // B4: đang tổng hợp
  COMPLETE: 'complete',           // B4: có final signing key
  ERROR: 'error',
};

// ─── LocalStorage persistence helpers for DKG resume ──────────────────────────

function dkgStep1Key(escrowId, addr) {
  return `dkg_step1_${escrowId}_${addr?.toLowerCase()}`;
}
function dkgStep2Key(escrowId, addr) {
  return `dkg_step2_${escrowId}_${addr?.toLowerCase()}`;
}

function loadStep1(escrowId, addr) {
  try {
    const raw = localStorage.getItem(dkgStep1Key(escrowId, addr));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveStep1(escrowId, addr, data) {
  try { localStorage.setItem(dkgStep1Key(escrowId, addr), JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function loadStep2Done(escrowId, addr) {
  try { return !!localStorage.getItem(dkgStep2Key(escrowId, addr)); } catch { return false; }
}

function saveStep2Done(escrowId, addr) {
  try { localStorage.setItem(dkgStep2Key(escrowId, addr), '1'); } catch { /* storage unavailable */ }
}

export function clearDkgLocalState(escrowId, addr) {
  try {
    localStorage.removeItem(dkgStep1Key(escrowId, addr));
    localStorage.removeItem(dkgStep2Key(escrowId, addr));
    localStorage.removeItem(`dkg_sigkey_${escrowId}_${addr?.toLowerCase()}`);
  } catch { /* storage unavailable */ }
}

/**
 * @param {string} escrowId
 * @param {string} myRole         - role hiện tại của user
 * @param {Function} executeWorkerTask  - từ useTssWorker (executeWorkerTask raw function)
 * @param {string} privKeyHex     - private key của user (từ storage)
 * @param {string} address        - wallet address (để key localStorage)
 */
export function useDkgPhase(escrowId, myRole, executeWorkerTask, privKeyHex, address) {
  const addLog = useSetAtom(addSystemLogAtom);
  const [state, setState] = useState(DKG_STATE.IDLE);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ commitmentsReceived: 0, sharesReceived: 0 });
  // Kết quả cuối cùng sau bước 4
  const [dkgResult, setDkgResult] = useState(null);
  // Refs để tránh re-run khi dependency thay đổi giữa await chains
  const runningRef = useRef(false);
  const autoResumeRef = useRef(false);
  // Ref tới runDkg để auto-resume gọi được (tránh circular dep với useCallback)
  const runDkgRef = useRef(null);

  // Auto-resume DKG sau khi login lại: nếu đã bắt đầu DKG (có polynomial đã lưu) nhưng
  // chưa hoàn tất (chưa có private signing key), tự động chạy tiếp toàn bộ runDkg.
  // runDkg tự bỏ qua các bước đã xong (step1/step2) và chạy tiếp tới bước 3-4.
  useEffect(() => {
    if (autoResumeRef.current || !escrowId || !myRole || !privKeyHex || !address || state !== DKG_STATE.IDLE) return;
    const savedStep1 = loadStep1(escrowId, address);
    if (!savedStep1) return;
    autoResumeRef.current = true;
    addLog({ message: `[DKG] Phát hiện DKG đang dở. Auto-resume để hoàn tất...`, type: 'info' });
    const timer = setTimeout(() => {
      if (runningRef.current === false && runDkgRef.current) {
        runDkgRef.current();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [escrowId, myRole, privKeyHex, address, state, addLog]);

  const runDkg = useCallback(async () => {
    if (runningRef.current) return;
    if (!escrowId || !myRole || !privKeyHex) {
      setError('escrowId, myRole, và privKeyHex là bắt buộc để chạy DKG');
      return;
    }

    runningRef.current = true;
    setError(null);

    try {
      // ─── Bước 1: Sinh polynomial + upload commitments ─────────────────────
      // Resume from localStorage if step 1 was already completed in a previous session
      let savedStep1 = loadStep1(escrowId, address);
      let coeffs, commitments, pubKeyHex;

      if (savedStep1?.coeffs && savedStep1?.pubKeyHex && savedStep1?.commitments) {
        ({ coeffs, pubKeyHex, commitments } = savedStep1);
        setState(DKG_STATE.COMMITTED);
        addLog({ message: `[DKG B1] Tiếp tục từ polynomial đã lưu. Đang kiểm tra commitments trên server...`, type: 'info' });
        // Re-upload commitment (idempotent) to ensure it's on server
        try {
          await api.post(`/escrow/${escrowId}/dkg/commitment`, { role: myRole, commitments, pubKeyHex });
        } catch (e) {
          if (!e?.response?.status || e.response.status !== 409) {
            addLog({ message: `[DKG B1] Cảnh báo upload commitment: ${e.message}`, type: 'warning' });
          }
        }
      } else {
        setState(DKG_STATE.GENERATING);
        addLog({ message: `[DKG B1] Đang sinh polynomial bậc 4 và Feldman commitments...`, type: 'info' });

        const polyResult = await executeWorkerTask('COMPUTE_DKG_POLYNOMIAL', { escrowId, privKeyHex });
        ({ commitments, pubKeyHex, coeffs } = polyResult);

        // Persist polynomial so step 2 can resume after page refresh
        saveStep1(escrowId, address, { coeffs, pubKeyHex, commitments });

        addLog({ message: `[DKG B1] Đã sinh ${commitments.length} commitments. Uploading...`, type: 'info' });
        await api.post(`/escrow/${escrowId}/dkg/commitment`, { role: myRole, commitments, pubKeyHex });

        setState(DKG_STATE.COMMITTED);
        addLog({ message: `[DKG B1] Commitments đã upload. Chờ ${TOTAL_PARTIES - 1} parties khác...`, type: 'success' });
      }

      // ─── Chờ tất cả 7 parties commit (polling) ──────────────────────────
      await waitForAllCommitments(escrowId, addLog, setProgress);

      // ─── Bước 2: Fetch pubkeys của tất cả parties, tính và upload shares ──
      // Skip if already done in a previous session
      if (loadStep2Done(escrowId, address)) {
        setState(DKG_STATE.SHARES_SENT);
        addLog({ message: `[DKG B2] Shares đã upload từ session trước. Chờ parties khác...`, type: 'info' });
      } else {
        addLog({ message: `[DKG B2] Đang tính và mã hoá shares cho ${TOTAL_PARTIES - 1} parties...`, type: 'info' });

        const sharesResp = await api.get(`/escrow/${escrowId}/dkg/shares?toRole=${myRole}`);
        const allPubKeys = sharesResp.data.pubKeys; // { role: pubKeyHex }

        // Tính shares cho TẤT CẢ parties kể cả chính mình (self-share)
        const allParties = ALL_ROLES
          .map(role => ({
            role,
            participantId: ROLE_TO_ID[role],
            pubKeyHex: role === myRole ? pubKeyHex : allPubKeys[role],
          }))
          .filter(p => p.pubKeyHex);

        if (allParties.length !== TOTAL_PARTIES) {
          throw new Error(`Thiếu pubkeys: nhận được ${allParties.length}/${TOTAL_PARTIES} parties`);
        }

        const sharesPayload = await executeWorkerTask('COMPUTE_DKG_SHARES', {
          escrowId,
          myPrivKeyHex: privKeyHex,
          parties: allParties,
          coeffs, // fallback if worker memory was cleared by page refresh
        });

        await api.post(`/escrow/${escrowId}/dkg/share`, {
          fromRole: myRole,
          shares: sharesPayload.shares,
        });

        saveStep2Done(escrowId, address);
        setState(DKG_STATE.SHARES_SENT);
        addLog({ message: `[DKG B2] Đã upload ${sharesPayload.shares.length} encrypted shares (kể cả self). Chờ parties khác...`, type: 'success' });
      }

      // ─── Chờ tất cả parties gửi shares đến mình ──────────────────────────
      await waitForAllShares(escrowId, myRole, addLog, setProgress);

      // ─── Bước 3: Fetch + decrypt + Feldman verify ─────────────────────────
      setState(DKG_STATE.VERIFYING);
      addLog({ message: `[DKG B3] Đang fetch, giải mã, và verify ${TOTAL_PARTIES - 1} shares...`, type: 'info' });

      const fetchedData = await api.get(`/escrow/${escrowId}/dkg/shares?toRole=${myRole}`);
      const { shares: incomingShares, commitments: allCommitments, pubKeys: allPubKeysMap } = fetchedData.data;

      const verifiedShares = [];
      for (const shareEntry of incomingShares) {
        const { fromRole, encryptedBlob } = shareEntry;
        const senderPubKey = allPubKeysMap[fromRole];
        if (!senderPubKey) {
          addLog({ message: `[DKG B3] ⚠️ Thiếu pubkey của ${fromRole}, bỏ qua.`, type: 'warning' });
          continue;
        }

        // Giải mã
        const decryptResult = await executeWorkerTask('COMPUTE_ECDH_DECRYPT', {
          recipientPrivKeyHex: privKeyHex,
          senderPubKeyHex: senderPubKey,
          encryptedBlob,
        });
        const shareHex = decryptResult.shareHex;

        // Feldman verify
        const senderCommitments = allCommitments[fromRole];
        const verifyResult = await executeWorkerTask('VERIFY_DKG_SHARE', {
          shareHex,
          commitments: senderCommitments,
          participantId: ROLE_TO_ID[myRole],
        });

        if (!verifyResult.valid) {
          throw new Error(`Feldman verification thất bại cho share từ ${fromRole}!`);
        }
        verifiedShares.push(shareHex);
        addLog({ message: `[DKG B3] ✅ Share từ ${fromRole} hợp lệ.`, type: 'info' });
      }

      setState(DKG_STATE.VERIFIED);

      // ─── Bước 4: Aggregate + tính final signing key ───────────────────────
      setState(DKG_STATE.AGGREGATING);
      addLog({ message: `[DKG B4] Tổng hợp ${verifiedShares.length} shares thành final signing key...`, type: 'info' });

      const aggregateResult = await executeWorkerTask('AGGREGATE_DKG_SHARES', {
        shares: verifiedShares,
      });

      const { finalShareHex, signingPubKey } = aggregateResult;

      setState(DKG_STATE.COMPLETE);
      setDkgResult({ finalShareHex, signingPubKey });

      addLog({
        message: `[DKG B4] ✅ DKG hoàn tất! Signing key = (${signingPubKey.x.slice(0, 10)}..., ${signingPubKey.y.slice(0, 10)}...)`,
        type: 'success',
      });

      return { finalShareHex, signingPubKey };
    } catch (err) {
      setState(DKG_STATE.ERROR);
      setError(err.message);
      addLog({ message: `[DKG Error] ${err.message}`, type: 'error' });
      throw err;
    } finally {
      runningRef.current = false;
    }
  }, [escrowId, myRole, privKeyHex, address, executeWorkerTask, addLog]);

  // Giữ ref tới runDkg mới nhất để auto-resume effect gọi được
  useEffect(() => { runDkgRef.current = runDkg; }, [runDkg]);

  return { state, error, progress, dkgResult, runDkg };
}

// ─── Polling helpers ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 phút (dkgDueAt)

async function waitForAllCommitments(escrowId, addLog, setProgress) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const resp = await api.get(`/escrow/${escrowId}/dkg/shares?toRole=buyer`);
    // Dùng commitmentsMap count làm proxy
    const count = Object.keys(resp.data.commitments || {}).length;
    setProgress(p => ({ ...p, commitmentsReceived: count }));
    if (count >= TOTAL_PARTIES) return;
    addLog({ message: `[DKG B1] Chờ commitments: ${count}/${TOTAL_PARTIES}...`, type: 'info' });
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('DKG timeout: không đủ commitments trong 30 phút');
}

async function waitForAllShares(escrowId, myRole, addLog, setProgress) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const resp = await api.get(`/escrow/${escrowId}/dkg/shares?toRole=${myRole}`);
    const count = resp.data.sharesReady || 0;
    setProgress(p => ({ ...p, sharesReceived: count }));
    // Cần nhận đủ TOTAL_PARTIES shares (7): 6 từ parties khác + 1 self-share
    if (count >= TOTAL_PARTIES) return;
    addLog({ message: `[DKG B2] Chờ shares gửi đến ${myRole}: ${count}/${TOTAL_PARTIES}...`, type: 'info' });
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('DKG timeout: không đủ shares trong 30 phút');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

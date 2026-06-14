# Refund & Timeout Flow Documentation

## Overview
Tài liệu này mô tả chi tiết luồng xử lý khi giao dịch escrow có vấn đề (dispute) hoặc timeout trong hệ thống hiện tại. Bao gồm các bước từ khi phát sinh vấn đề đến khi hoàn tiền cho buyer hoặc release cho seller.

---

## 1. Luồng Timeout (Passive Protection → DISPUTED)

### Scenario
Nếu escrow ở trạng thái `LOCKED` và quá `timeoutDeadline` (tính từ lúc `lockFunds()` on-chain) mà không bên nào hành động (thường do người bán không giao hàng), hệ thống chuyển escrow sang **DISPUTED** để hội đồng hòa giải phán quyết. Timeout **không** tự trả tiền cho seller.

### Implementation Status: ✅ DONE

### Trigger on-chain: `triggerTimeout()`
Quá hạn được kích hoạt on-chain bởi **hàm permissionless** `triggerTimeout()` (ai cũng gọi được, không cần chữ ký):
- Điều kiện: `status == LOCKED` và `block.timestamp > timeoutDeadline`.
- Hành động: `status = DISPUTED`, `timeoutDeadline = type(uint256).max`, đặt `disputeDeadline = now + DISPUTE_TIMEOUT (3 ngày)`, emit `DisputeOpened`.

Hai nguồn kích hoạt (theo thiết kế "cả hai"):
1. **Nút FE** — bất kỳ bên tham gia nào bấm "Kích hoạt quá hạn" sau khi đồng hồ đếm ngược về 0 (tự trả gas).
2. **Cron relayer (fallback)** — nếu không ai bấm, cron gọi `triggerTimeout()` bằng ví relayer.

### Key Components

#### 1.1 Cron Job: `checkTimeoutEscrows()` (relayer fallback)
**File**: [backend/src/workers/cron-jobs.js](../backend/src/workers/cron-jobs.js)

```
Chạy mỗi giờ (config: TIMEOUT_CHECK_CRON_PATTERN = '0 * * * *')
  ↓
Tìm escrow WHERE status = 'LOCKED' AND timeoutDeadline < now() AND contractAddress != null
  ↓
Với mỗi escrow timeout:
  - Ví relayer gọi vault.triggerTimeout() ON-CHAIN (không flip DB trực tiếp)
  - Idempotent: bỏ qua nếu on-chain không còn LOCKED (đã có ai bấm nút)
  ↓
DB chuyển LOCKED → DISPUTED qua event DisputeOpened (event listener),
đồng thời khởi tạo dispute lifecycle (disputePhase, deadlines).
```

> Contract là nguồn sự thật cho LOCKED→DISPUTED; DB đồng bộ theo event, tránh lệch trạng thái.

#### 1.2 Dispute Lifecycle Initialization
**File**: [backend/src/lib/dispute-lifecycle.js](../backend/src/lib/dispute-lifecycle.js)

Khi timeout xảy ra, hệ thống tự động khởi tạo:
```javascript
{
  disputePhase: "OPENED",
  disputeOpenedAt: <timestamp>,
  evidenceDeadlineAt: now + (24h + 72h),    // DISPUTE_OPEN_ACK_HOURS + DISPUTE_EVIDENCE_WINDOW_HOURS
  reviewDeadlineAt: now + (24h + 72h + 48h), // + DISPUTE_REVIEW_WINDOW_HOURS
  decisionDeadlineAt: now + (24h + 72h + 48h + 12h) // + DISPUTE_DECISION_GRACE_HOURS
}
```

#### 1.3 Dispute Phase Auto-Progression
**File**: [backend/src/workers/cron-jobs.js](../backend/src/workers/cron-jobs.js) → `checkDisputePhaseTransitions()`

Tự động chuyển phase khi deadline trôi qua:
```
OPENED (24h) → EVIDENCE_WINDOW (72h) → REVIEW_WINDOW (48h) → DECISION_PENDING (12h) → RESOLVED
```

---

## 2. Luồng Dispute Resolution (Mediator Voting)

### Scenario
Khi escrow vào trạng thái `DISPUTED` (do timeout hoặc user khởi tạo), 5 mediators sẽ vote để quyết định:
- **RELEASE_TO_BUYER** hoặc **RETURN_TO_SELLER** hoặc **SPLIT** hoặc **OTHER**

### Implementation Status: ✅ PARTIALLY DONE (Database & API ready, Contract execution pending)

### Key Components

#### 2.1 Dispute Creation
**File**: [backend/src/routes/disputes.js](../backend/src/routes/disputes.js)

**NOT FOUND**: Hiện tại không thấy endpoint `POST /api/disputes` trong codebase. Nghi ngờ chỉ có `PATCH /api/escrows/:id/status` với status='DISPUTED'.

#### 2.2 Mediator Assignment & Acceptance
**File**: [backend/src/routes/disputes.js](../backend/src/routes/disputes.js)

```
POST /api/disputes/:id/accept-mediator
  ├─ Verify EIP-712 signature
  ├─ Consume mediator nonce
  ├─ Update disputeMediator.status: ASSIGNED → accepted/declined
  └─ Queue event: MEDIATOR_ACCEPTED / MEDIATOR_DECLINED
```

#### 2.3 Mediator Voting
**File**: [backend/src/routes/disputes.js](../backend/src/routes/disputes.js#L492)

```
POST /api/disputes/:id/vote
  ├─ Verify mediator is assigned and accepted
  ├─ Verify EIP-712 vote signature
  ├─ Create DisputeVote with vote, justification, evidenceRefs
  ├─ Update disputeMediator.status: accepted → voted
  ├─ Consume mediator nonce
  ├─ Queue event: VOTE_SUBMITTED
  └─ Call finalizeDisputeVotes()
```

#### 2.4 Vote Tally & Finalization
**File**: [backend/src/services/dispute-finalize.js](../backend/src/services/dispute-finalize.js#L35)

```javascript
finalizeDisputeVotes(disputeId)
  ├─ Fetch all votes from dispute
  ├─ Build tally:
  │   {
  │     RELEASE_TO_BUYER: <count>,
  │     RETURN_TO_SELLER: <count>,
  │     SPLIT: <count>,
  │     OTHER: <count>
  │   }
  ├─ Check threshold (5 votes for 5-of-7):
  │   if any vote count >= threshold:
  │     outcome = <vote_type>
  ├─ Update dispute.status: VOTING → RESOLVED
  ├─ Store outcome on dispute model
  ├─ Queue events:
  │   - VOTE_TALLY_UPDATED
  │   - DISPUTE_FINALIZED (if outcome reached)
  └─ Emit websocket events:
      - vote-tally-updated
      - dispute-finalized
```

---

## 3. Luồng Refund (Outcome Resolution)

### Scenario
Khi mediators vote outcome = `RETURN_TO_SELLER` (hiểu là REFUND cho Buyer), hệ thống cần:
1. Cập nhật DB escrow status: DISPUTED → REFUNDED
2. Gọi smart contract `refund()` để transfer tiền về buyer
3. Listen event on-chain `FundsReleased` từ contract
4. Cập nhật DB: xác nhận giao dịch hoàn thành

### Implementation Status: ⚠️ PARTIAL (DB update done, Contract execution NOT YET)

### Key Components

#### 3.1 DB Status Transition
**File**: [backend/src/routes/escrows.js](../backend/src/routes/escrows.js#L350)

```
PATCH /api/escrows/:id/status
  Body: { status: 'REFUNDED', reason: 'Mediator voted RETURN_TO_SELLER' }
  ├─ Verify participant (buyer/seller/mediator can patch)
  ├─ Transition validation: DISPUTED → REFUNDED ✓
  ├─ Update escrow.status = REFUNDED
  ├─ Set disputePhase = RESOLVED
  ├─ Record escrowStatusHistory
  └─ Emit websocket event: dispute-resolved
```

#### 3.2 On-Chain Contract Call: `refund()`
**File**: [contracts/EscrowVault.sol](../contracts/EscrowVault.sol#L97)

```solidity
function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint256 signerBitmap) external {
  require(status == LOCKED || status == DISPUTED, "Invalid status");
  
  // Schnorr signature verification
  _verifyAction("refund", rAddr, z, e, msgHash, signerBitmap);
  
  // Execute refund
  status = REFUNDED;
  _payout(buyer);  // Send funds to buyer
  
  emit FundsReleased(escrowId, buyer, signerBitmap, "refund");
}
```

**Status**: ⚠️ Contract function exists, but BACKEND does NOT auto-call it yet.

**Missing**: Backend needs logic to:
1. After VOTE_FINALIZED with outcome = RETURN_TO_SELLER
2. Aggregate signatures from 5-of-7 mediators
3. Call `EscrowVault.refund(rAddr, z, e, msgHash, signerBitmap)`
4. Store on-chain txHash in dispute.onChainTxHash

#### 3.3 Event Listener: FundsReleased
**File**: [backend/src/workers/event-listener-worker.js](../backend/src/workers/event-listener-worker.js)

```
When FundsReleased event detected from contract:
  ├─ Extract escrowId, recipient, action (refund/release)
  ├─ Verify action == "refund"
  ├─ Update DB:
  │   escrow.status = REFUNDED
  │   escrow.contractAddress = vault address
  └─ Emit notification to frontend
```

---

## 4. Luồng Release (Happy Path & Timeout Release)

### 4.1 Release (Happy Path)
**Scenario**: 5 mediators vote RELEASE_TO_BUYER (seller phục vụ tốt, buyer confirm)

**Contract Call**:
```solidity
function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint256 signerBitmap) external {
  require(status == LOCKED || status == DISPUTED);
  _verifyAction("release", rAddr, z, e, msgHash, signerBitmap);
  
  status = RELEASED;
  _payout(seller);  // Send funds to seller
  
  emit FundsReleased(escrowId, seller, signerBitmap, "release");
}
```

**Status**: ⚠️ Same as refund - contract ready, backend integration pending.

### 4.2 Trigger Timeout (Passive → DISPUTED)
**Scenario**: Escrow vẫn LOCKED, quá `timeoutDeadline`. Bất kỳ ai cũng có thể kích hoạt chuyển sang DISPUTED (không trả thẳng cho seller — quyết định do hội đồng).

**Contract Call**:
```solidity
function triggerTimeout() external {
  if (status != LOCKED) revert InvalidStatus();
  if (block.timestamp <= timeoutDeadline) revert NotTimedOut();

  status = DISPUTED;
  timeoutDeadline = type(uint256).max;
  disputeDeadline = block.timestamp + DISPUTE_TIMEOUT; // 3 ngày
  emit DisputeOpened(escrowId);
}
```

**⚠️ IMPORTANT**: `dispute()` và `triggerTimeout()` đều đặt `timeoutDeadline = max` và mở dispute; khác biệt: `dispute()` chỉ buyer/seller gọi (chủ động), `triggerTimeout()` ai cũng gọi được sau khi hết hạn (thụ động).

### 4.3 Timeout TRONG hòa giải (Auto Split + Slash)
**Scenario**: Đã DISPUTED nhưng hội đồng không phán quyết kịp (quá `disputeDeadline` / decision deadline). Hệ thống tự chia đôi tiền và phạt các hòa giải viên gây trễ.

**Contract**: `timeoutSplit()` (permissionless, không cần chữ ký)
```solidity
function timeoutSplit() external {
  if (status != DISPUTED) revert InvalidStatus();
  if (block.timestamp <= disputeDeadline) revert DisputeNotTimedOut();
  // chia 50/50 cho buyer & seller
  status = RELEASED;
  _payout(buyer, amount/2);
  _payout(seller, amount - amount/2);
  emit FundsSplit(escrowId, buyer, seller, buyerAmount, sellerAmount, 0);
}
```

**Backend executor** ([backend/src/services/timeout-resolution-executor.js](../backend/src/services/timeout-resolution-executor.js)) — chạy khi cron chuyển phase `DECISION_PENDING → RESOLVED` mà dispute chưa có outcome do vote:
1. Ví relayer gọi `vault.timeoutSplit()` → chia 50/50 (DB → RELEASED qua event `FundsSplit`).
2. Xác định MV **không bỏ phiếu** (DisputeMediator trừ DisputeVote) → gọi `MediatorPool.slashForTimeout(mv, buyer, seller)` (phạt 30% stake, bù cho buyer/seller).
3. Cập nhật `Dispute`: `status='TIMED_OUT'`, `outcome='SPLIT'`, `onChainTxHash`.
4. Idempotent: bỏ qua nếu on-chain đã RELEASED/REFUNDED hoặc dispute đã chốt bằng vote.

---

## 5. Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ESCROW LIFECYCLE                                    │
└─────────────────────────────────────────────────────────────────────────────┘

       DRAFT ──→ CREATED ──→ LOCKED
                              │
                    ┌─────────┴─────────┬────────────────┐
                    │                   │                │
              [HAPPY PATH]        [TIMEOUT]         [DISPUTE]
                    │                   │                │
                    ↓                   ↓                ↓
            RELEASE (seller)    DISPUTED ←───────── automatic/manual
            (happy path)        (auto or user)
                                        │
                        ┌───────────────┴───────────────┐
                        │ Dispute Phases                │
                        ├───────────────────────────────┤
                        │ 1. OPENED (24h)               │
                        │    - Mediators accept/decline │
                        │                               │
                        │ 2. EVIDENCE_WINDOW (72h)      │
                        │    - Parties upload evidence  │
                        │                               │
                        │ 3. REVIEW_WINDOW (48h)        │
                        │    - Mediators review         │
                        │                               │
                        │ 4. DECISION_PENDING (12h)     │
                        │    - Finalize votes           │
                        │                               │
                        │ 5. RESOLVED                   │
                        │    - Outcome determined       │
                        └───────────────┬───────────────┘
                                        │
                        ┌───────────────┼───────────────┐
                        │               │               │
                        ↓               ↓               ↓
                 RELEASED         REFUNDED            SPLIT
                (seller wins)    (buyer gets $)    (50/50 split)
```

---

## 6. Current Implementation Status Matrix

| Component | Status | File | Notes |
|-----------|--------|------|-------|
| **Timeout Trigger (FE button)** | ✅ DONE | `EscrowDetail.jsx`, `useContractCall.js` | Bất kỳ bên nào gọi `triggerTimeout()` sau khi đếm ngược về 0 |
| **Timeout Trigger (cron relayer)** | ✅ DONE | `cron-jobs.js`, `timeout-resolution-executor.js` | Fallback: relayer gọi `triggerTimeout()` on-chain; DB sync qua `DisputeOpened` |
| **Countdown Timer (FE)** | ✅ DONE | `useTimeoutCountdown.js` | Đếm ngược `timeoutDeadline` (LOCKED) / `disputeDeadline` (DISPUTED) |
| **Dispute Phase Auto-Progression** | ✅ DONE | `cron-jobs.js` | OPENED → EVIDENCE → REVIEW → DECISION → RESOLVED |
| **Mediator Assignment** | ✅ DONE | `disputes.js` | VRF + manual assignment |
| **Mediator Accept/Decline** | ✅ DONE | `disputes.js` | EIP-712 signed, nonce protected |
| **Mediator Voting** | ✅ DONE | `disputes.js` | EIP-712 signed votes, nonce protected |
| **Vote Tally Calculation** | ✅ DONE | `dispute-finalize.js` | 5-of-7 threshold check |
| **Database Status Transition** | ✅ DONE | `escrows.js` | DISPUTED → RELEASED/REFUNDED |
| **Refund Contract Call** | ⚠️ TODO | `dispute-finalize.js` | Need backend to aggregate sig + call `refund()` |
| **Release Contract Call** | ⚠️ TODO | `dispute-finalize.js` | Need backend to aggregate sig + call `release()` |
| **Mediation Timeout (split + slash)** | ✅ DONE | `timeout-resolution-executor.js`, `EscrowVault.sol`, `MediatorPool.sol` | Quá `disputeDeadline` → `timeoutSplit()` 50/50 + `slashForTimeout()` các MV không vote |
| **Event Listener: FundsReleased** | ✅ DONE | `event-listener-worker.js` | Syncs on-chain events back to DB |
| **WebSocket Real-time Updates** | ✅ DONE | `socket-emitter.js` | Emits vote-tally-updated, dispute-finalized, etc. |

---

## 7. Missing Pieces & TODOs

### 7.1 Backend: Aggregate Signatures & Call Contract
After `finalizeDisputeVotes()` returns outcome, backend should:

```javascript
if (outcome === 'RETURN_TO_SELLER') {
  // 1. Fetch 5 mediator signatures from disputeMediator records
  // 2. Aggregate Schnorr signatures into combined (R_addr, z, e)
  // 3. Build msgHash = keccak256(chainId, contractAddress, escrowId, "refund", signerBitmap)
  // 4. Call vault.refund(R_addr, z, e, msgHash, signerBitmap)
  // 5. Store txHash in dispute.onChainTxHash
}
```

**Location**: Should be in `backend/src/services/dispute-finalize.js` or new `backend/src/services/contract-executor.js`

### 7.2 Frontend: Show Status & Trigger Contract Call
After vote finalization, frontend should:
- Display "Outcome decided: REFUND to Buyer" (or RELEASE)
- **Option A**: Frontend calls backend endpoint to trigger contract execution
- **Option B**: Frontend directly calls contract with aggregated signature

### 7.3 Timeout Flow — ✅ RESOLVED
Quyết định cuối: timeout là **cơ chế bảo vệ thụ động → DISPUTED** (không trả thẳng cho seller), vì quá hạn thường do người bán không giao hàng.
- Kích hoạt: nút FE (bất kỳ bên) + cron relayer fallback, cùng gọi `triggerTimeout()`.
- Hết hạn trong hòa giải: tự `timeoutSplit()` (50/50) + `slashForTimeout()` (phạt MV không vote).

---

## 8. API Endpoints Summary

### Dispute Creation (Missing?)
```
POST /api/disputes
  Body: { escrowId, reason, description }
  Response: { disputeId, status: "MEDIATORS_ASSIGNED", mediators: [...] }
```

### Mediator Accept/Decline
```
POST /api/disputes/:id/accept-mediator
  Body: { decision: "accept"/"decline", signature, message }
  Response: { mediatorId, status: "accepted"/"declined" }
```

### Vote
```
POST /api/disputes/:id/vote
  Body: { vote, justification, evidenceRefs, signature, message }
  Response: { status: "ACCEPTED", currentTally: {...} }
```

### Evidence Signature
```
POST /api/disputes/:id/evidence/:evidenceId/signature
  Body: { signature, message }
  Response: { evidenceId, signature: "0x..." }
```

### Finalize
```
POST /api/disputes/:id/finalize
  Response: { onChainTxHash: null, finalizedAt: "2026-05-01T12:00:00Z" }
```

### Status Transition (Generic)
```
PATCH /api/escrows/:id/status
  Body: { status: "REFUNDED"/"RELEASED", reason: "Mediator voted..." }
  Response: { escrowId, status: "REFUNDED", updatedAt: "..." }
```

---

## 9. Key Questions for Design Review

1. **Who triggers contract calls?**
   - Should backend auto-call after vote finalization?
   - Or should frontend submit signature + call contract?

2. **Timeout behavior:** ✅ RESOLVED — timeout → DISPUTED (qua `triggerTimeout()`), không trả thẳng cho seller. Hết hạn hòa giải → `timeoutSplit()` + slash.

3. **Refund semantics:**
   - Is "REFUND" = "RETURN_TO_SELLER" (return funds to buyer)?
   - Or should there be "SPLIT" option for 50/50?

4. **Error handling:**
   - What happens if contract call fails after DB status change?
   - Should we revert DB or retry contract call?

---

## 10. References

- Smart Contracts: [contracts/EscrowVault.sol](../contracts/EscrowVault.sol)
- Backend Routes: [backend/src/routes/disputes.js](../backend/src/routes/disputes.js), [backend/src/routes/escrows.js](../backend/src/routes/escrows.js)
- Cron Jobs: [backend/src/workers/cron-jobs.js](../backend/src/workers/cron-jobs.js)
- Event Listener: [backend/src/workers/event-listener-worker.js](../backend/src/workers/event-listener-worker.js)
- Dispute Finalization: [backend/src/services/dispute-finalize.js](../backend/src/services/dispute-finalize.js)
- Use Cases: [docs/use-cases-and-user-stories.md](./use-cases-and-user-stories.md)

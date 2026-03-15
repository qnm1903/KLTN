import express from 'express';
import { sessions } from '../store/session.js';
import { initDKG } from '../crypto/dkg.js';
import { aggregateAndSign } from '../crypto/tss.js';
import { ethers } from 'ethers';

const router = express.Router();

// Phase 1: DKG (khởi tạo escrow)
router.post('/init', async (req, res) => {
  try {
    const { escrowId, buyerAddr, sellerAddr, mediatorAddr } = req.body;

    if (!escrowId || !buyerAddr || !sellerAddr || !mediatorAddr) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await initDKG(escrowId, sessions);

    const sessionDetail = sessions.get(escrowId);
    sessionDetail.parties = {
      buyer: buyerAddr.toLowerCase(),
      seller: sellerAddr.toLowerCase(),
      mediator: mediatorAddr.toLowerCase()
    };
    sessions.set(escrowId, sessionDetail);

    res.json(result);
  } catch (error) {
    console.error('Error in /init:', error);
    res.status(500).json({ error: error.message });
  }
});

// Phase 2: Threshold Signing
router.post('/partial-sign', async (req, res) => {
  try {
    const { escrowId, role, action, share } = req.body;

    if (!escrowId || !role || !action || !share) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sessionData = sessions.get(escrowId);
    if (!sessionData) {
      return res.status(404).json({ error: 'Escrow session not found' });
    }

    // TODO: Verify signature Ethereum của user ở đây để authenticate (Phase tăng cường bảo mật, Làm khi có Frontend)

    const existingShare = sessionData.partialShares.find(s => s.role === role);
    if (!existingShare) {
      const shareIndex = sessionData.shares[role].index;
      sessionData.partialShares.push({ index: shareIndex, share: share, role });

      const io = req.app.get('io');
      if (io) {
        io.to(escrowId).emit('sig_received', { count: sessionData.partialShares.length, needed: 2 });
      }
    }

    if (sessionData.partialShares.length >= 2) {
      // Đủ 2 share -> tổng hợp thành chữ ký
      // Lấy toàn bộ mảng share copy và CLEAR trạng thái Session ngay lập tức để tránh Deadlock
      const currentShares = [...sessionData.partialShares];
      sessionData.partialShares = [];
      sessions.set(escrowId, sessionData);

      // Tạo Raw Hash (tương đương ABI.encodePacked của Solidity)
      const formattedEscrowId = typeof escrowId === 'string' && escrowId.startsWith('0x') ? escrowId : ethers.id(escrowId);
      const packedHash = ethers.solidityPackedKeccak256(
        ['bytes32', 'string'],
        [formattedEscrowId, action]
      );
      
      // Hầu hết Smart Contract (OpenZeppelin) dùng chuẩn \x19Ethereum Signed Message:\n32 kèm độ dài.
      // Ethers hashMessage sẽ làm việc này thay vì hash trần bytes32, giúp chữ ký không bị giả mạo.
      const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(packedHash));

      // Thực thi gom khoá và Ký với format Signed Message Hash
      const sig = aggregateAndSign(currentShares, ethSignedMessageHash);

      const io = req.app.get('io');
      if (io) {
        io.to(escrowId).emit('sig_complete', {
          r: sig.r,
          s: sig.s,
          v: sig.v,
          msgHash: ethSignedMessageHash, // Chú ý: Đây là Hash đã prepended
          rawHash: packedHash // Hash nguyên bản trên SC để debug
        });
      }

      return res.json({ r: sig.r, s: sig.s, v: sig.v, msgHash: ethSignedMessageHash, rawHash: packedHash });
    } else {
      // Cập nhật session tạm khi chưa đủ share
      sessions.set(escrowId, sessionData);
      return res.json({ received: sessionData.partialShares.length, needed: 2 });
    }

  } catch (error) {
    console.error('Error in /partial-sign:', error);
    // Văng lỗi thì báo frontend, session vẫn sạch vì đã cleard array từ bên trên
    res.status(500).json({ error: error.message });
  }
});

// Lấy thông tin session status
router.get('/:id/status', (req, res) => {
  const sessionData = sessions.get(req.params.id);
  if (!sessionData) {
    return res.status(404).json({ error: 'Escrow session not found' });
  }
  res.json({
    status: sessionData.status,
    sigCount: sessionData.partialShares.length,
    parties: sessionData.parties,
    pkAggAddress: sessionData.pkAggAddress
  });
});

// Dispute endpoint (gọi khi buyer tranh chấp)
router.post('/dispute', (req, res) => {
  const { escrowId, reason } = req.body;
  const sessionData = sessions.get(escrowId);
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }
  sessionData.status = 'DISPUTED';
  sessions.set(escrowId, sessionData);
  res.json({ ok: true });
});

export default router;
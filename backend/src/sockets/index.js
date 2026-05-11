import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';

function parseToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const trimmed = rawToken.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim() || null;
  }
  return trimmed;
}

function parseJoinPayload(payload) {
  if (typeof payload === 'string') {
    return { escrowId: payload.trim(), token: null };
  }

  if (payload && typeof payload === 'object') {
    return {
      escrowId: String(payload.escrowId || '').trim(),
      token: parseToken(payload.token)
    };
  }

  return { escrowId: '', token: null };
}

function extractSocketToken(socket, payloadToken = null) {
  if (payloadToken) return payloadToken;

  const authToken = parseToken(socket.handshake?.auth?.token);
  if (authToken) return authToken;

  const headerToken = parseToken(socket.handshake?.headers?.authorization);
  if (headerToken) return headerToken;

  const queryToken = parseToken(socket.handshake?.query?.token);
  if (queryToken) return queryToken;

  return null;
}

async function checkEscrowParticipantAccess(escrowId, userId) {
  const escrow = await prisma.escrow.findUnique({
    where: { id: escrowId },
    select: {
      id: true,
      chainEscrowId: true,
      buyerId: true,
      sellerId: true,
      escrowMediators: {
        select: { mediatorId: true }
      }
    }
  });

  if (!escrow) {
    return { ok: false, error: 'Escrow not found' };
  }

  const isMediator = Array.isArray(escrow.escrowMediators)
    && escrow.escrowMediators.some((row) => row.mediatorId === userId);

  if (escrow.buyerId !== userId && escrow.sellerId !== userId && !isMediator) {
    return { ok: false, error: 'You are not a participant in this escrow' };
  }

  return { ok: true, escrow };
}

export function setupSockets(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Cầu nối Worker -> Server -> Trình duyệt
    socket.on('worker:mediators_selected', (payload) => {
      try {
        const { escrowId, chainEscrowId, mediators } = payload || {};
        if (!escrowId || !mediators) return;
        console.log(`[socket] Nhận được mediators_selected từ Worker cho Escrow ${escrowId}`);
        io.to(escrowId).emit('mediators_selected', { escrowId, chainEscrowId, mediators });
      } catch (err) {
        console.error('[socket] Lỗi khi re-broadcasting:', err);
      }
    });

    // Client tham gia room của escrow sau khi xác thực JWT và quyền participant.
    socket.on('join_escrow', async (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};

      try {
        const { escrowId, token: payloadToken } = parseJoinPayload(payload);
        if (!escrowId) {
          respond({ ok: false, error: 'escrowId is required' });
          return;
        }

        const token = extractSocketToken(socket, payloadToken);
        const jwtSecret = process.env.JWT_SECRET;

        if (!token || !jwtSecret) {
          respond({ ok: false, error: 'Authentication is required' });
          socket.emit('dispute-room-join-denied', { escrowId, error: 'Authentication is required' });
          return;
        }

        let decoded;
        try {
          decoded = jwt.verify(token, jwtSecret);
        } catch {
          respond({ ok: false, error: 'Invalid or expired token' });
          socket.emit('dispute-room-join-denied', { escrowId, error: 'Invalid or expired token' });
          return;
        }

        const userId = decoded?.id;
        if (!userId) {
          respond({ ok: false, error: 'Invalid token payload' });
          socket.emit('dispute-room-join-denied', { escrowId, error: 'Invalid token payload' });
          return;
        }

        const access = await checkEscrowParticipantAccess(escrowId, userId);
        if (!access.ok) {
          respond({ ok: false, error: access.error });
          socket.emit('dispute-room-join-denied', { escrowId, error: access.error });
          return;
        }

        socket.join(access.escrow.id);
        if (access.escrow.chainEscrowId) {
          socket.join(access.escrow.chainEscrowId);
        }

        console.log(`Socket ${socket.id} joined room: ${escrowId}`);
        respond({ ok: true, escrowId });
      } catch (error) {
        const escrowId = typeof payload === 'string' ? payload : payload?.escrowId;
        console.error('Failed to join escrow room', {
          socketId: socket.id,
          escrowId,
          payload,
          error
        });
        respond({ ok: false, error: 'Failed to join escrow room' });
        socket.emit('dispute-room-join-denied', {
          escrowId,
          error: 'Failed to join escrow room'
        });
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  return io;
}

// Events broadcast qua io.to(escrowId).emit() từ routes/escrow.js:
//   'pubkey_received'           — { escrowId, role, received, required, missingRoles }
//   'pubkey_rejected'           — { escrowId, role, reason }
//   'pubkey_collection_complete'— { escrowId, received, required, completedAt }
//   'pubkey_collection_expired' — { escrowId, dueAt, expiredAt }
//   'nonce_received'   — { escrowId, count, needed }  khi nhận được 1 nonce
//   'nonce_collected'  — { escrowId, R_addr, challenge, msgHash, pkAgg, signerBitmap }  khi đủ 2 nonces
//   'z_received'       — { escrowId, count, needed }  khi nhận được 1 z share
//   'schnorr_complete' — { escrowId, vaultContractAddress, R_addr, z, e, msgHash, signerBitmap }  chữ ký cuối — dùng để gọi contract
// Events dispute từ routes/escrows.js và routes/evidence.js:
//   'dispute-opened'         — khi escrow chuyển sang DISPUTED
//   'dispute-phase-changed'  — khi phase dispute thay đổi
//   'dispute-evidence-added' — khi có bằng chứng mới
//   'dispute-resolved'       — khi dispute kết thúc (RELEASED/REFUNDED)
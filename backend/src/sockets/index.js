import { Server } from 'socket.io';

export function setupSockets(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Client tham gia room của escrow để nhận broadcast từ server
    socket.on('join_escrow', (escrowId) => {
      socket.join(escrowId);
      console.log(`Socket ${socket.id} joined room: ${escrowId}`);
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  return io;
}

// Events broadcast qua io.to(escrowId).emit() từ routes/escrow.js:
//   'nonce_received'   — { count, needed }  khi nhận được 1 nonce
//   'nonce_collected'  — { R_addr, challenge, msgHash, pkAgg }  khi đủ 2 nonces
//   'z_received'       — { count, needed }  khi nhận được 1 z share
//   'schnorr_complete' — { R_addr, z, e, msgHash }  chữ ký cuối — dùng để gọi contract
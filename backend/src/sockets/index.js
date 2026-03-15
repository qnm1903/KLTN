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

    // Client tham gia room dựa trên escrowId
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
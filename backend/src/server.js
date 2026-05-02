import http from 'http';
import dotenv from 'dotenv';
import app from './app.js';
import prisma from './lib/prisma.js';
import { setupSockets } from './sockets/index.js';
import { setIO } from './lib/socket-emitter.js';
import { startDisputeOutboxWorker } from './workers/dispute-outbox-worker.js';

dotenv.config();

const server = http.createServer(app);

// Setup WebSocket
const io = setupSockets(server);

// Lưu io instance vào express app
app.set('io', io);
setIO(io);

const outboxWorker = startDisputeOutboxWorker({ prisma, logger: console });

const shutdown = async (signal) => {
  console.info(`[server] Received ${signal}. Shutting down...`);
  outboxWorker.stop();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('[server] Shutdown error:', error.message);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('[server] Shutdown error:', error.message);
    process.exit(1);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
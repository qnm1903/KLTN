import dotenv from 'dotenv';
import prisma from '../lib/prisma.js';
import { startDisputeOutboxWorker } from './dispute-outbox-worker.js';

dotenv.config();

async function main() {
  const worker = startDisputeOutboxWorker({ prisma, logger: console });

  const shutdown = async (signal) => {
    console.info(`[outbox] Received ${signal}. Shutting down...`);
    worker.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error('[outbox] Shutdown error:', error.message);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error('[outbox] Shutdown error:', error.message);
      process.exit(1);
    });
  });

  console.info('[outbox] Worker started.');
}

main().catch(async (error) => {
  console.error('[outbox] Startup failed:', error.message);
  try {
    await prisma.$disconnect();
  } catch (disconnectError) {
    console.error('[outbox] Prisma disconnect failed:', disconnectError?.message ?? disconnectError);
  }
  process.exit(1);
});

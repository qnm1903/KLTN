import dotenv from 'dotenv';
import prisma from '../lib/prisma.js';
import { startEventListenerWorker } from './event-listener-worker.js';
import { startCronJobs, stopCronJobs } from './cron-jobs.js';

dotenv.config();

async function main() {
  const worker = startEventListenerWorker({ prisma, logger: console });
  startCronJobs(prisma, { logger: console });

  const shutdown = async (signal) => {
    console.info(`[listener] Received ${signal}. Shutting down...`);
    stopCronJobs({ logger: console });
    await worker.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT').catch((error) => {
    console.error('[listener] Shutdown error:', error.message);
    process.exit(1);
  }); });

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch((error) => {
    console.error('[listener] Shutdown error:', error.message);
    process.exit(1);
  }); });

  console.info('[listener] Worker started.');
}

main().catch(async (error) => {
  console.error('[listener] Startup failed:', error.message);
  try {
    await prisma.$disconnect();
  } catch (disconnectError) {
    console.error('[listener] Prisma disconnect failed:', disconnectError?.message ?? disconnectError);
  }
  process.exit(1);
});
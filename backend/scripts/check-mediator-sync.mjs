import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const rawUrl = process.env.DATABASE_URL;
const url = rawUrl && rawUrl !== 'undefined' ? rawUrl : 'file:./dev.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const adapter = new PrismaLibSql({ url, authToken });
const prisma = new PrismaClient({ adapter, errorFormat: 'minimal' });

async function main() {
  const TARGET_ESCROW_ID = 'dfdf7c62-5803-4084-82ee-fbf8b757c9b8';

  // Check status history for this escrow
  const history = await prisma.escrowStatusHistory.findMany({
    where: { escrowId: TARGET_ESCROW_ID },
    orderBy: { createdAt: 'asc' }
  });

  console.log('=== Status History ===');
  for (const h of history) {
    console.log(`  ${h.fromStatus} → ${h.toStatus} | ${h.source} | ${h.createdAt}`);
  }

  // Check PubKeySubmissions
  const pubkeys = await prisma.pubKeySubmission.findMany({
    where: { escrowId: TARGET_ESCROW_ID }
  });
  console.log(`\n=== PubKey Submissions: ${pubkeys.length} ===`);
  for (const p of pubkeys) {
    console.log(`  role: ${p.role}, submittedAt: ${p.submittedAt}`);
  }

  // Check if the EscrowCreatedEvent was processed (contractAddress should be set)
  const escrow = await prisma.escrow.findUnique({
    where: { id: TARGET_ESCROW_ID },
    select: {
      status: true,
      chainEscrowId: true,
      contractAddress: true,
      escrowMediators: true
    }
  });
  
  console.log('\n=== Escrow State ===');
  console.log(`status: ${escrow?.status}`);
  console.log(`chainEscrowId: ${escrow?.chainEscrowId ?? 'NULL'}`);
  console.log(`contractAddress: ${escrow?.contractAddress ?? 'NULL — EscrowCreatedEvent chưa được xử lý!'}`);
  console.log(`escrowMediators count: ${escrow?.escrowMediators.length}`);

  // Check ProcessedChainEvent
  const processed = await prisma.processedChainEvent.findMany({
    where: { escrowId: TARGET_ESCROW_ID }
  });
  console.log(`\n=== ProcessedChainEvents: ${processed.length} ===`);
  for (const p of processed) {
    console.log(`  ${p.eventName} | block: ${p.blockNumber} | tx: ${p.txHash}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());

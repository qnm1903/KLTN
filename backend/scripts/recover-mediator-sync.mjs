/**
 * Recovery Script: Sync EscrowMediator từ tx hash của RandomMediatorSelected event
 * Chạy: node scripts/recover-mediator-sync.mjs <txHash>
 * 
 * txHash: Transaction hash của RandomMediatorSelected event (từ Blockscout/Etherscan)
 * Ví dụ: node scripts/recover-mediator-sync.mjs 0x7dbbe6487d...
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
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

const mediatorPoolAbi = [
  'event RandomMediatorSelected(bytes32 indexed escrowId, address[] mediators)',
];

function normalizeAddress(value) {
  if (!value) return null;
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return String(value).toLowerCase().trim();
  }
}

async function main() {
  const TX_HASH = process.argv[2];

  if (!TX_HASH) {
    console.error('❌ Thiếu txHash!');
    console.error('   Cú pháp: node scripts/recover-mediator-sync.mjs <txHash>');
    console.error('   Ví dụ:   node scripts/recover-mediator-sync.mjs 0x7dbbe6487d...');
    process.exit(1);
  }

  console.log(`\n🔍 Đang lấy thông tin từ tx: ${TX_HASH}\n`);

  // 1. Kết nối blockchain bằng HTTP RPC (không cần WebSocket)
  const rpcUrl = (process.env.RPC_URL || process.env.WS_RPC_URL || '')
    .replace('wss://', 'https://')
    .replace('ws://', 'http://');
  
  if (!rpcUrl) {
    console.error('❌ Không tìm thấy RPC_URL trong .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const mediatorPoolAddress = process.env.MEDIATOR_POOL_CONTRACT;
  if (!mediatorPoolAddress) {
    console.error('❌ Không tìm thấy MEDIATOR_POOL_CONTRACT trong .env');
    process.exit(1);
  }

  // 2. Lấy transaction receipt (không bị giới hạn block range)
  const receipt = await provider.getTransactionReceipt(TX_HASH);
  if (!receipt) {
    console.error(`❌ Không tìm thấy transaction receipt cho ${TX_HASH}`);
    process.exit(1);
  }
  if (receipt.status === 0) {
    console.error(`❌ Transaction ${TX_HASH} đã bị revert on-chain!`);
    process.exit(1);
  }

  console.log(`✅ Transaction tìm thấy tại block: ${receipt.blockNumber}`);

  // 3. Parse logs để lấy RandomMediatorSelected event
  const iface = new ethers.Interface(mediatorPoolAbi);
  let foundEscrowId = null;
  let foundMediators = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== mediatorPoolAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'RandomMediatorSelected') {
        foundEscrowId = parsed.args[0];   // bytes32
        foundMediators = parsed.args[1];  // address[]
        break;
      }
    } catch { /* bỏ qua logs không phải mediatorPool */ }
  }

  if (!foundEscrowId || !foundMediators) {
    console.error('❌ Không tìm thấy RandomMediatorSelected event trong transaction này!');
    console.error('   Hãy kiểm tra lại txHash có phải là tx của RandomMediatorSelected không.');
    process.exit(1);
  }

  console.log(`\n📋 Event data:`);
  console.log(`   chainEscrowId: ${foundEscrowId}`);
  console.log(`   Mediators (${foundMediators.length}):`);
  for (let i = 0; i < foundMediators.length; i++) {
    console.log(`     Slot ${i+1}: ${foundMediators[i]}`);
  }

  // 4. Tìm escrow trong DB
  const normalizedChainEscrowId = foundEscrowId.toLowerCase();
  const escrow = await prisma.escrow.findFirst({
    where: {
      OR: [
        { chainEscrowId: normalizedChainEscrowId },
        { chainEscrowId: foundEscrowId }
      ]
    },
    select: {
      id: true,
      chainEscrowId: true,
      contractAddress: true,
      status: true,
      buyer: { select: { walletAddress: true } },
      seller: { select: { walletAddress: true } },
      escrowMediators: { select: { slot: true } }
    }
  });

  if (!escrow) {
    console.error(`\n❌ Không tìm thấy escrow với chainEscrowId=${foundEscrowId} trong DB!`);
    console.error('   Hãy kiểm tra lại chainEscrowId có đúng không.');
    process.exit(1);
  }

  console.log(`\n📋 Escrow tìm được trong DB:`);
  console.log(`   ID: ${escrow.id}`);
  console.log(`   status: ${escrow.status}`);
  console.log(`   contractAddress: ${escrow.contractAddress ?? 'NULL'}`);
  console.log(`   buyer: ${escrow.buyer?.walletAddress}`);
  console.log(`   seller: ${escrow.seller?.walletAddress}`);
  console.log(`   Mediators hiện tại: ${escrow.escrowMediators.length}/5`);

  if (escrow.escrowMediators.length === 5) {
    console.log('\n✅ Escrow đã có đủ 5 mediators. Không cần recovery.');
    return;
  }

  // 5. Lưu mediators vào DB
  console.log(`\n📝 Đang lưu ${foundMediators.length} mediators vào DB...`);

  for (let i = 0; i < foundMediators.length; i++) {
    const addr = normalizeAddress(foundMediators[i]);

    const user = await prisma.user.upsert({
      where: { walletAddress: addr },
      update: { isMediator: true, role: 'MEDIATOR' },
      create: { walletAddress: addr, role: 'MEDIATOR', isMediator: true },
      select: { id: true }
    });

    await prisma.escrowMediator.upsert({
      where: { escrowId_slot: { escrowId: escrow.id, slot: i + 1 } },
      update: { mediatorId: user.id },
      create: { escrowId: escrow.id, mediatorId: user.id, slot: i + 1 }
    });

    console.log(`   ✅ Slot ${i+1}: ${addr} (userId=${user.id.slice(0, 8)}...)`);
  }

  console.log(`\n🎉 Đã lưu thành công ${foundMediators.length} mediators!`);

  // 6. Trigger DKG init qua API (backend phải đang chạy)
  const buyerAddr = normalizeAddress(escrow.buyer?.walletAddress);
  const sellerAddr = normalizeAddress(escrow.seller?.walletAddress);
  const mediatorAddrs = Array.from(foundMediators).map(m => normalizeAddress(m));

  const baseUrl = `http://localhost:${process.env.PORT || 3001}/api`;
  console.log(`\n🚀 Kích hoạt DKG session via ${baseUrl}/escrow/init...`);

  try {
    const initRes = await fetch(`${baseUrl}/escrow/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        escrowId: escrow.id,
        chainId: process.env.CHAIN_ID || '11155111',
        contractAddress: escrow.contractAddress || null,
        buyerAddr,
        sellerAddr,
        mediatorAddrs
      })
    });

    const text = await initRes.text();
    if (initRes.status === 409) {
      console.log(`   ⚠️  DKG session đã tồn tại (409) - bỏ qua khởi tạo`);
    } else if (!initRes.ok) {
      console.error(`   ❌ DKG init thất bại (${initRes.status}): ${text}`);
    } else {
      console.log(`   ✅ DKG session khởi tạo thành công!`);
      console.log(`   ${text}`);
    }
  } catch (apiErr) {
    console.warn(`   ⚠️  Không gọi được API: ${apiErr.message}`);
    console.warn(`   → Mediators đã lưu vào DB. Restart listener để DKG tự khởi động.`);
  }

  // 7. Kiểm tra kết quả cuối
  const final = await prisma.escrow.findUnique({
    where: { id: escrow.id },
    select: {
      status: true,
      escrowMediators: {
        select: { slot: true, mediator: { select: { walletAddress: true } } },
        orderBy: { slot: 'asc' }
      }
    }
  });

  console.log(`\n📊 Trạng thái sau recovery:`);
  console.log(`   status: ${final?.status}`);
  for (const m of final?.escrowMediators || []) {
    console.log(`   Slot ${m.slot}: ${m.mediator?.walletAddress}`);
  }
}

main().catch(err => {
  console.error('\n❌ Recovery thất bại:', err.message);
  process.exit(1);
}).finally(() => prisma.$disconnect());

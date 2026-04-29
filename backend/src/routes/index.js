import express from 'express';
import escrowRouter from './escrow.js';     // TSS Crypto endpoints (init, nonce, sign)
import authRouter from './auth.js';         // SIWE Auth (nonce, verify)
import usersRouter from './users.js';       // User profile & mediator list
import escrowsRouter from './escrows.js';   // Business Escrow CRUD
import evidenceRouter from './evidence.js'; // Dispute Evidence upload
import mediatorRouter from './mediator.js'; // Mediator Pool management

const router = express.Router();

// Auth — không cần JWT
router.use('/auth', authRouter);

// TSS Crypto — giữ nguyên (chưa yêu cầu JWT để tương thích test cũ)
router.use('/escrow', escrowRouter);

// Business APIs — cần JWT
router.use('/users', usersRouter);
router.use('/escrows', escrowsRouter);
router.use('/escrows', evidenceRouter);
router.use('/mediator', mediatorRouter);

export default router;
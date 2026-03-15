import express from 'express';
import escrowRouter from './escrow.js';

const router = express.Router();

router.use('/escrow', escrowRouter);

export default router;
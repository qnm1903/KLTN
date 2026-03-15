import express from 'express';
import cors from 'cors';
import mainRouter from './routes/index.js';

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

// Routes chính của ứng dụng
app.use('/api', mainRouter);

export default app;
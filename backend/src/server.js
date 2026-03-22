import http from 'http';
import dotenv from 'dotenv';
import app from './app.js';
import { setupSockets } from './sockets/index.js';

dotenv.config();

const server = http.createServer(app);

// Setup WebSocket
const io = setupSockets(server);

// Lưu io instance vào express app
app.set('io', io);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
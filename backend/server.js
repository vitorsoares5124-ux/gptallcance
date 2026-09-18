// server.js
// AllcanceAI backend — Express server with Image Support
// Endpoints:
//   POST /chat          → send a message (and optional image), returns AI response + images
//   GET  /status        → current pool status (JSON)
//   GET  /status/stream → SSE stream for real-time status + logs

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initialize, chat, getStatus, events } from './accountManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// 25mb limit to support high-resolution base64 images
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// Serve the frontend from ../frontend
app.use(express.static(join(__dirname, '../frontend')));

// ─── SSE: Real-time status + log stream ──────────────────────────────────────

const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

events.on('status', (status) => broadcastSSE('status', status));
events.on('log', (line) => broadcastSSE('log', { line }));

app.get('/status/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.add(res);

  // Send current status immediately on connect
  res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);

  req.on('close', () => sseClients.delete(res));
});

// ─── REST ─────────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json(getStatus());
});

app.post('/chat', async (req, res) => {
  const { message, image } = req.body;
  if ((!message || typeof message !== 'string' || !message.trim()) && !image) {
    return res.status(400).json({ error: 'message or image is required' });
  }

  try {
    const result = await chat((message || '').trim(), image || null);
    res.json(result);
  } catch (err) {
    console.error('[Server] Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ╔═══════════════════════════╗');
  console.log('  ║   AllcanceAI — starting   ║');
  console.log('  ╚═══════════════════════════╝');
  console.log('');

  try {
    await initialize();
  } catch (err) {
    console.error('[Server] Initialization failed:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n  ✓ Running at http://localhost:${PORT}\n`);
  });
}

main();

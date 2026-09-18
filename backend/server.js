// server.js
// AllcanceAI backend — Express server with Image Support & Fast Boot
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
// 50mb limit to support high-resolution base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
  const { message, image, conversationId, history, stream = true } = req.body;
  if ((!message || typeof message !== 'string' || !message.trim()) && !image) {
    return res.status(400).json({ error: 'message or image is required' });
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send immediate initial event so client knows stream is established
    res.write(`event: start\ndata: ${JSON.stringify({ status: 'connected' })}\n\n`);

    try {
      const result = await chat(
        (message || '').trim(),
        image || null,
        conversationId || null,
        history || [],
        (chunkText) => {
          res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunkText })}\n\n`);
        }
      );
      res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
      res.end();
    } catch (err) {
      console.error('[Server] Chat stream error:', err.message);
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  } else {
    try {
      const result = await chat((message || '').trim(), image || null, conversationId || null, history || []);
      res.json(result);
    } catch (err) {
      console.error('[Server] Chat error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ╔═══════════════════════════╗');
  console.log('  ║   AllcanceAI — starting   ║');
  console.log('  ╚═══════════════════════════╝');
  console.log('');

  // 1. Start HTTP server immediately so localhost:3000 responds instantly
  app.listen(PORT, () => {
    console.log(`\n  ✓ Running at http://localhost:${PORT}\n`);
  });

  // 2. Initialize the browser account pool in the background
  try {
    initialize().catch((err) => {
      console.error('[Server] Pool initialization warning:', err.message);
    });
  } catch (err) {
    console.error('[Server] Pool initialization error:', err.message);
  }
}

main();

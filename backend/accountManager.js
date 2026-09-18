// sessionPool.js (accountManager.js)
// Manages a warm pool of browser sessions with transparent rotation,
// session persistence across restarts, and context injection across account switches.

import { EventEmitter } from 'events';
import { resumeOrCreateSession, runQuery } from './automation.js';
import fs from 'fs';
import path from 'path';

export const events = new EventEmitter();

const HISTORY_DIR = path.join(process.cwd(), 'history');
const HISTORY_FILE = path.join(HISTORY_DIR, 'conversation.json');

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

// In-memory conversation history persisted to disk
let conversationHistory = [];

function loadHistory() {
  ensureHistoryDir();
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      conversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (_) {
      conversationHistory = [];
    }
  }
}

function saveHistory() {
  ensureHistoryDir();
  try {
    // Keep last 40 turns of history to prevent token overflow while maintaining deep context
    const trimmed = conversationHistory.slice(-40);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (_) {}
}

const pool = {
  active:  null,   // { id, email, page, context, browser, msgCount, isFresh, createdAt }
  standby: null,
};

let isProvisioning = false;

// ─── Internal ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts   = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  events.emit('log', line);
}

function emitStatus() {
  events.emit('status', getStatus());
}

async function provisionSlot(role) {
  if (isProvisioning && role === 'standby') {
    log('[Pool] Standby already provisioning — skipping duplicate');
    return;
  }

  if (role === 'standby') isProvisioning = true;
  log(`[Pool] Preparing ${role} session...`);
  emitStatus();

  try {
    const result = await resumeOrCreateSession(role, log);
    const session = {
      id:        `s_${Date.now()}`,
      email:     result.email,
      page:      result.page,
      context:   result.context,
      browser:   result.browser,
      msgCount:  0,
      isFresh:   !result.isResumed, // If resumed, ChatGPT already has the thread
      createdAt: new Date().toISOString(),
    };

    pool[role] = session;
    log(`[Pool] ${role.toUpperCase()} session ready → ${result.email} (${result.isResumed ? 'Resumed' : 'New'})`);
    emitStatus();
  } catch (err) {
    log(`[Pool] Failed to prepare ${role}: ${err.message}. Retrying in 15s...`);
    pool[role] = null;
    emitStatus();
    setTimeout(() => provisionSlot(role), 15_000);
  } finally {
    if (role === 'standby') isProvisioning = false;
  }
}

async function rotate() {
  log('[Pool] Quota reached — rotating sessions...');

  if (!pool.standby) {
    log('[Pool] No warm session ready — waiting...');
    const deadline = Date.now() + 180_000;
    while (!pool.standby && Date.now() < deadline) {
      await sleep(2000);
    }
    if (!pool.standby) throw new Error('Rotation failed: no standby after 3min');
  }

  if (pool.active) {
    if (pool.active.context) pool.active.context.close().catch(() => {});
    if (pool.active.browser) pool.active.browser.close().catch(() => {});
  }

  pool.active  = pool.standby;
  // Brand new promoted session must receive context injection on its first prompt
  pool.active.isFresh = true;
  pool.standby = null;

  log(`[Pool] Rotated. Primary: ${pool.active.email}`);
  emitStatus();

  provisionSlot('standby');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Boot the pool. Resumes active session or provisions fresh.
 */
export async function initialize() {
  log('[Pool] Initializing with Session & History Persistence...');
  loadHistory();
  await provisionSlot('active');
  setTimeout(() => provisionSlot('standby'), 12000);
}

/**
 * Send a query (text + optional image). Transparently injects context on fresh accounts.
 * @param {string} message - User text prompt
 * @param {object|string|null} image - Base64 image or { dataUrl, filename }
 */
export async function chat(message, image = null) {
  if (!pool.active) throw new Error('Pool not ready');

  const session = pool.active;
  log(`[Pool] Query via ${session.email} (#${session.msgCount + 1})${image ? ' [image]' : ''}`);

  // ── Prepare Context Injection if this account is fresh and we have history ──
  let historyContext = null;
  if (session.isFresh && conversationHistory.length > 0) {
    const formattedLines = conversationHistory.slice(-20).map((turn) => {
      const prefix = turn.role === 'user' ? 'Usuário' : 'Assistente';
      return `${prefix}: ${turn.text}`;
    });

    historyContext = `[INSTRUÇÃO DO SISTEMA: Esta é a continuação direta de uma conversa prévia. Mantenha 100% da continuidade de contexto, fatos citados e tom de resposta das mensagens anteriores.]\n\n--- HISTÓRICO RECENTE ---\n${formattedLines.join('\n\n')}\n--- FIM DO HISTÓRICO ---`;
    log(`[Pool] Context injection active (${conversationHistory.length} turns in memory)`);
  }

  const result = await runQuery(session.page, message, image, historyContext, log);
  session.msgCount++;
  session.isFresh = false; // Next prompts in this session will use ChatGPT's live thread

  if (result.isLimited) {
    log('[Pool] Quota hit — rotating...');
    await rotate();
    log('[Pool] Retrying query with new session (Context Injection will carry history)...');
    return await chat(message, image);
  }

  // Record into persistent history
  conversationHistory.push({
    role: 'user',
    text: message || (image ? '[Imagem enviada]' : ''),
    hasImage: !!image,
    timestamp: new Date().toISOString(),
  });

  conversationHistory.push({
    role: 'assistant',
    text: result.text,
    timestamp: new Date().toISOString(),
  });

  saveHistory();

  return {
    text: result.text,
    images: result.images || [],
    account: session.email,
    msgCount: session.msgCount,
  };
}

/**
 * Current pool status for the frontend.
 */
export function getStatus() {
  return {
    active:          pool.active  ? { email: pool.active.email,  msgCount: pool.active.msgCount } : null,
    standby:         pool.standby ? { email: pool.standby.email } : null,
    creatingStandby: isProvisioning,
    historyCount:    conversationHistory.length,
  };
}

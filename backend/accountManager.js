// accountManager.js
// Manages a warm pool of browser sessions with transparent rotation,
// 2-standby buffer pool for 0ms failover, session persistence across restarts,
// and per-conversation context injection.

import { EventEmitter } from 'events';
import { resumeOrCreateSession, runQuery } from './automation.js';

export const events = new EventEmitter();

const MAX_STANDBYS = 2;

const pool = {
  active:   null,   // { id, email, page, context, browser, msgCount, isFresh, currentConversationId, createdAt }
  standbys: [],     // Array of standby sessions ready for instant failover
};

let provisioningCount = 0;

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

async function provisionStandbyIfNeeded() {
  if (pool.standbys.length + provisioningCount >= MAX_STANDBYS) return;
  provisionSlot('standby');
}

async function provisionSlot(role) {
  if (role === 'standby') {
    if (pool.standbys.length + provisioningCount >= MAX_STANDBYS) return;
    provisioningCount++;
  }

  log(`[Pool] Preparing ${role} session... (Standbys: ${pool.standbys.length}/${MAX_STANDBYS})`);
  emitStatus();

  try {
    const result = await resumeOrCreateSession(role, log);
    const session = {
      id:        `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      email:     result.email,
      page:      result.page,
      context:   result.context,
      browser:   result.browser,
      msgCount:  0,
      isFresh:   !result.isResumed,
      currentConversationId: null,
      createdAt: new Date().toISOString(),
    };

    if (role === 'active') {
      pool.active = session;
    } else {
      pool.standbys.push(session);
    }

    log(`[Pool] ${role.toUpperCase()} session ready → ${result.email} (${result.isResumed ? 'Resumed' : 'New'})`);
    emitStatus();

    // If we have fewer standbys than MAX_STANDBYS, queue next standby
    if (pool.standbys.length < MAX_STANDBYS) {
      setTimeout(() => provisionStandbyIfNeeded(), 5000);
    }
  } catch (err) {
    log(`[Pool] Failed to prepare ${role}: ${err.message}. Retrying in 15s...`);
    if (role === 'active' && !pool.active) {
      pool.active = null;
    }
    emitStatus();
    setTimeout(() => provisionSlot(role), 15_000);
  } finally {
    if (role === 'standby') {
      provisioningCount = Math.max(0, provisioningCount - 1);
    }
  }
}

async function rotate() {
  log('[Pool] Quota reached — rotating sessions...');

  if (pool.standbys.length === 0) {
    log('[Pool] No warm session in buffer — provisioning urgent standby...');
    provisionStandbyIfNeeded();
    const deadline = Date.now() + 180_000;
    while (pool.standbys.length === 0 && Date.now() < deadline) {
      await sleep(1500);
    }
    if (pool.standbys.length === 0) throw new Error('Rotation failed: no standby available after 3min');
  }

  if (pool.active) {
    if (pool.active.context) pool.active.context.close().catch(() => {});
    if (pool.active.browser) pool.active.browser.close().catch(() => {});
  }

  pool.active = pool.standbys.shift();
  // Brand new promoted session must receive context injection on its first prompt
  pool.active.isFresh = true;
  pool.active.currentConversationId = null;

  log(`[Pool] Rotated instantly. Primary: ${pool.active.email} (Remaining standbys: ${pool.standbys.length})`);
  emitStatus();

  // Top up standbys buffer in background
  provisionStandbyIfNeeded();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Boot the pool. Resumes active session and warms standby buffer.
 */
export async function initialize() {
  log('[Pool] Initializing with Per-Conversation Context Injection & 2-Standby Buffer...');
  await provisionSlot('active');
  setTimeout(() => provisionStandbyIfNeeded(), 8000);
}

/**
 * Send a query (text + optional image) with per-conversation context injection and live streaming.
 * @param {string} message - User text prompt
 * @param {object|string|null} image - Base64 image or { dataUrl, filename }
 * @param {string|null} conversationId - Current active conversation ID
 * @param {Array} history - Prior messages in this specific conversation
 * @param {Function|null} onChunk - Real-time chunk stream callback
 */
export async function chat(message, image = null, conversationId = null, history = [], onChunk = null) {
  if (!pool.active) throw new Error('Pool not ready — initializing browser session');

  const session = pool.active;
  log(`[Pool] Query via ${session.email} (#${session.msgCount + 1}) [Conv: ${conversationId || 'default'}]`);

  // ── Prepare Context Injection if this account is fresh or switched conversation ──
  let historyContext = null;
  const needsContext = (session.isFresh || session.currentConversationId !== conversationId) && history && history.length > 1;

  if (needsContext) {
    // Take previous turns (excluding the current user message)
    const previousTurns = history.slice(0, -1).slice(-16);
    if (previousTurns.length > 0) {
      const formattedLines = previousTurns.map((turn) => {
        const prefix = turn.role === 'user' ? 'Usuário' : 'Assistente';
        return `${prefix}: ${turn.text}`;
      });

      historyContext = `[INSTRUÇÃO DO SISTEMA: Esta é a continuação direta de uma conversa prévia específica. Mantenha 100% da continuidade de contexto, dados e tom de resposta das mensagens anteriores.]\n\n--- HISTÓRICO RECENTE DESTE CHAT ---\n${formattedLines.join('\n\n')}\n--- FIM DO HISTÓRICO ---`;
      log(`[Pool] Injecting context for conversation ${conversationId} (${previousTurns.length} previous turns)`);
    }
  }

  const result = await runQuery(session.page, message, image, historyContext, onChunk, log);
  session.msgCount++;
  session.isFresh = false;
  session.currentConversationId = conversationId;

  if (result.isLimited) {
    log('[Pool] Quota hit — rotating instantly...');
    await rotate();
    log('[Pool] Retrying query with warm standby (Context Injection will carry history)...');
    return await chat(message, image, conversationId, history, onChunk);
  }

  return {
    text: result.text,
    images: result.images || [],
    account: session.email,
    msgCount: session.msgCount,
    conversationId,
  };
}

/**
 * Current pool status for the frontend.
 */
export function getStatus() {
  return {
    active:          pool.active ? { email: pool.active.email, msgCount: pool.active.msgCount } : null,
    standbys:        pool.standbys.map(s => ({ email: s.email })),
    standbyCount:    pool.standbys.length,
    creatingStandby: provisioningCount > 0,
  };
}

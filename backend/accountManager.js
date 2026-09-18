// sessionPool.js (accountManager.js)
// Manages a warm pool of browser sessions with transparent rotation,
// session persistence across restarts, and per-conversation context injection.

import { EventEmitter } from 'events';
import { resumeOrCreateSession, runQuery } from './automation.js';

export const events = new EventEmitter();

const pool = {
  active:  null,   // { id, email, page, context, browser, msgCount, isFresh, currentConversationId, createdAt }
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
      isFresh:   !result.isResumed,
      currentConversationId: null,
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
  pool.active.currentConversationId = null;
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
  log('[Pool] Initializing with Per-Conversation Context Injection...');
  await provisionSlot('active');
  setTimeout(() => provisionSlot('standby'), 12000);
}

/**
 * Send a query (text + optional image) with per-conversation context injection.
 * @param {string} message - User text prompt
 * @param {object|string|null} image - Base64 image or { dataUrl, filename }
 * @param {string|null} conversationId - Current active conversation ID
 * @param {Array} history - Prior messages in this specific conversation
 */
export async function chat(message, image = null, conversationId = null, history = []) {
  if (!pool.active) throw new Error('Pool not ready');

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

  const result = await runQuery(session.page, message, image, historyContext, log);
  session.msgCount++;
  session.isFresh = false;
  session.currentConversationId = conversationId;

  if (result.isLimited) {
    log('[Pool] Quota hit — rotating...');
    await rotate();
    log('[Pool] Retrying query with new session (Context Injection will carry history)...');
    return await chat(message, image, conversationId, history);
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
    active:          pool.active  ? { email: pool.active.email,  msgCount: pool.active.msgCount } : null,
    standby:         pool.standby ? { email: pool.standby.email } : null,
    creatingStandby: isProvisioning,
  };
}

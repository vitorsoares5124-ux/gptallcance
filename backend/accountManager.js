// sessionPool.js (accountManager.js)
// Manages a warm pool of browser sessions with transparent rotation.
// Supports text prompts and image uploads / vision / DALL-E responses.

import { EventEmitter } from 'events';
import { provisionSession, runQuery } from './automation.js';

export const events = new EventEmitter();

const pool = {
  active:  null,   // { id, email, page, context, browser, msgCount, createdAt }
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
  log(`[Pool] Provisioning ${role} session...`);
  emitStatus();

  try {
    const result  = await provisionSession(log);
    const session = {
      id:        `s_${Date.now()}`,
      email:     result.email,
      page:      result.page,
      context:   result.context,
      browser:   result.browser,
      msgCount:  0,
      createdAt: new Date().toISOString(),
    };

    pool[role] = session;
    log(`[Pool] ${role.toUpperCase()} session ready → ${result.email}`);
    emitStatus();
  } catch (err) {
    log(`[Pool] Failed to provision ${role}: ${err.message}. Retrying in 15s...`);
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
 * Boot the pool. Provisions primary first, then warm standby after delay.
 */
export async function initialize() {
  log('[Pool] Initializing...');
  await provisionSlot('active');
  setTimeout(() => provisionSlot('standby'), 12000);
}

/**
 * Send a query (text + optional image). Rotates transparently on quota hit.
 * @param {string} message - User text prompt
 * @param {object|string|null} image - Base64 image or { dataUrl, filename }
 */
export async function chat(message, image = null) {
  if (!pool.active) throw new Error('Pool not ready');

  const session = pool.active;
  log(`[Pool] Query via ${session.email} (#${session.msgCount + 1})${image ? ' [with image attachment]' : ''}`);

  const result = await runQuery(session.page, message, image, log);
  session.msgCount++;

  if (result.isLimited) {
    log('[Pool] Quota hit — rotating...');
    await rotate();
    log('[Pool] Retrying query with new session...');
    return await chat(message, image);
  }

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
  };
}

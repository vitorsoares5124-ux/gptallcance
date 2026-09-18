// session.js (automation.js)
// Browser session provisioning & persistence for QA automation suite.
//
// Supports:
//   - Persistent session storage across restarts (storageState)
//   - Real-time token/chunk streaming
//   - Text queries and image attachments (Vision & DALL-E)
//   - Context Injection across session rotations

import { chromium } from 'playwright';
import { createInboxAccount, waitForVerificationCode } from './tempmail.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSIONS_DIR = path.join(process.cwd(), 'sessions');

function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

// ─── Browser instance ─────────────────────────────────────────────────────────

const cfg = {
  target: process.env.TARGET_URL || 'https://chatgpt.com',
  loginPath: process.env.LOGIN_PATH || '/auth/login',
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

async function createFreshBrowser() {
  // Headless por padrão (nada aparece na barra de tarefas).
  // Para DEPURAR vendo o navegador, rode: $env:HEADLESS='false'; npm start
  const isHeadless = process.env.HEADLESS !== 'false';
  return await chromium.launch({
    headless: isHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── DOM helpers ──────────────────────────────────────────────────────────────

async function getVisible(page, selectors) {
  for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    } catch (_) {}
  }
  return null;
}

// ─── Selector registry ────────────────────────────────────────────────────────

const SEL = {
  credential: [
    '#mobile-auth-email',
    'input[name="login_hint"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
  ],
  verifyCode: [
    'input[name="code"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[placeholder*="digo" i]',
    'input[placeholder*="code" i]',
  ],
  displayName: [
    'input[name="name"]',
    'input[autocomplete="name"]',
    'input[name="fullName"]',
    'input[name="full_name"]',
    'input[name="displayName"]',
    'input[placeholder*="nome" i]',
    'input[placeholder*="name" i]',
    'input[placeholder*="completo" i]',
  ],
  ageField: [
    'input[name="age"]',
    'input[type="number"]',
  ],
  primaryBtn: [
    'button[type="submit"]',
    'button.btn-primary',
    'button:has-text("Continuar")',
    'button:has-text("Continue")',
    'button:has-text("Avançar")',
    'button:has-text("Next")',
    'button:has-text("Vamos lá")',
    'button:has-text("Vamos começar")',
    'button:has-text("Entendi")',
    'button:has-text("Entendido")',
    'button:has-text("Concluir")',
    'button:has-text("Done")',
    'button:has-text("OK")',
    'button:has-text("Ok")',
    'button:has-text("Fechar")',
    'button:has-text("Dismiss")',
    'button:has-text("Stay logged out")',
    'button:has-text("Fique desconectado")',
    'button[data-testid*="continue" i]',
    'button[data-testid*="next" i]',
    'button[data-testid*="submit" i]',
    'button[data-testid*="onboarding" i]',
  ],
  targetInterface: [
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea',
    'div[contenteditable="true"][data-lexical-editor]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
  ],
};

// ─── State detector ───────────────────────────────────────────────────────────

async function detectState(page) {
  if (await getVisible(page, SEL.targetInterface)) return 'SESSION_READY';
  if (await getVisible(page, SEL.displayName))     return 'PROFILE_FORM';
  if (await getVisible(page, SEL.verifyCode))      return 'VERIFY_FORM';
  if (await getVisible(page, SEL.credential))      return 'CREDENTIAL_FORM';
  if (await getVisible(page, SEL.primaryBtn))      return 'NEXT_BTN';

  try {
    const roleBtn = page.getByRole('button', { name: /continuar|continue|avançar|próximo|next|vamos|entendi|ok|concluir/i }).first();
    if (await roleBtn.isVisible({ timeout: 600 })) return 'NEXT_BTN';
  } catch (_) {}

  const url = page.url();
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  const isCloudflare = page.frames().some(f => f.url().includes('challenges.cloudflare.com')) ||
                       body.toLowerCase().includes('confirme que é humano') ||
                       body.toLowerCase().includes('confirm you are human') ||
                       body.toLowerCase().includes('just a moment');
  if (isCloudflare) {
    return 'CHALLENGE_FORM';
  }

  if (url.includes('error') ||
      body.toLowerCase().includes('something went wrong') ||
      body.toLowerCase().includes('algo deu errado')) {
    return 'FLOW_ERROR';
  }

  return 'LOADING';
}

// ─── Display name generator ───────────────────────────────────────────────────

function generateDisplayName() {
  const first = ['Lucas', 'Gabriel', 'Pedro', 'Rafael', 'Bruno', 'Mateus', 'Thiago', 'André', 'Felipe', 'Diego'];
  const last  = ['Silva', 'Santos', 'Oliveira', 'Pereira', 'Costa', 'Carvalho', 'Almeida', 'Ferreira', 'Rodrigues'];
  return `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
}

// ─── Session provisioning ─────────────────────────────────────────────────────

export async function provisionSession(log = console.log) {
  const browser = await createFreshBrowser();
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const vp = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];

  const context = await browser.newContext({
    userAgent: ua,
    viewport: vp,
    locale: 'pt-BR',
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });

  log('[Session] Provisioning custom domain account (@vaibly.com.br)...');
  const inboxAccount = await createInboxAccount();
  const { email } = inboxAccount;
  log(`[Session] Account Email: ${email}`);

  const page = await context.newPage();

  // Suppress automation fingerprint
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  try {
    log('[Session] Loading entry point...');
    await page.goto(`${cfg.target}${cfg.loginPath}`, {
      waitUntil: 'networkidle',
      timeout: 45000,
    });
    await sleep(2000);
    log(`[Session] URL: ${page.url()}`);

    // ── State machine ──────────────────────────────────────────────────────────
    let credentialSent = false;
    let codeSent       = false;
    let profileDone    = false;
    let codeValue      = null;
    let displayName    = generateDisplayName();
    let unknownCycles  = 0;
    let continueCycles = 0;
    let challengeStart = null;

    while (true) {
      const state = await detectState(page);
      log(`[Session] State: ${state} | ${page.url()}`);

      // ── SESSION_READY ──────────────────────────────────────────────────────
      if (state === 'SESSION_READY') {
        log(`[Session] ✓ Interface confirmed. Inbox: ${email}`);
        return { email, page, context, browser };
      }

      // ── CHALLENGE_FORM (Cloudflare Turnstile with Timeout Protection) ─────
      if (state === 'CHALLENGE_FORM') {
        if (!challengeStart) challengeStart = Date.now();
        if (Date.now() - challengeStart > 25000) {
          log('[Session] ⚠ Cloudflare challenge timeout — recycling session...');
          throw new Error('Cloudflare challenge timed out after 25s');
        }

        log('[Session] Cloudflare challenge detected — attempting interaction...');
        const iframes = await page.$$('iframe');
        let clicked = false;
        for (const ifr of iframes) {
          const src = await ifr.getAttribute('src').catch(() => '');
          if (src && src.includes('challenges.cloudflare.com')) {
            const box = await ifr.boundingBox().catch(() => null);
            if (box) {
              log('[Session] Clicking Cloudflare Turnstile checkbox...');
              await page.mouse.click(box.x + 35, box.y + box.height / 2);
              clicked = true;
              break;
            }
          }
        }
        await sleep(3500);
        continue;
      }

      challengeStart = null;

      // ── FLOW_ERROR ────────────────────────────────────────────────────────
      if (state === 'FLOW_ERROR') {
        const errorText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        log(`[Session] Flow error at URL: ${page.url()}`);
        log(`[Session] Page text: ${errorText.replace(/\n+/g, ' ').slice(0, 300)}`);
        await page.screenshot({ path: 'error_state.png' }).catch(() => {});
        if (!credentialSent) {
          log('[Session] Error before credential step — reloading entry point...');
          await page.goto(`${cfg.target}${cfg.loginPath}`, { waitUntil: 'networkidle', timeout: 30000 });
          await sleep(3000);
          continue;
        }
        throw new Error(`Flow error at ${page.url()} | ${errorText.slice(0, 100)}`);
      }

      // ── CREDENTIAL_FORM ───────────────────────────────────────────────────
      if (state === 'CREDENTIAL_FORM' && !credentialSent) {
        const input = await getVisible(page, SEL.credential);
        await input.click();
        await sleep(300);
        await input.type(email, { delay: 40 });
        await sleep(400);
        await page.keyboard.press('Tab');
        await sleep(300);
        log('[Session] Credential entered — advancing...');
        const btn = await getVisible(page, SEL.primaryBtn);
        if (btn) await btn.click();
        else await page.keyboard.press('Enter');
        credentialSent = true;
        await sleep(3000);
        continue;
      }

      // ── VERIFY_FORM ───────────────────────────────────────────────────────
      if (state === 'VERIFY_FORM' && !codeSent) {
        if (!codeValue) {
          log('[Session] Fetching verification code via API in background...');
          codeValue = await waitForVerificationCode(inboxAccount, page);
          log(`[Session] Code: ${codeValue}`);
        }
        const input = await getVisible(page, SEL.verifyCode);
        if (input) {
          try {
            await input.click({ force: true, timeout: 2000 });
          } catch (_) {}
          try {
            await input.fill(codeValue);
          } catch (_) {
            await input.type(codeValue, { delay: 30 }).catch(() => {});
          }
        }
        await sleep(600);
        log('[Session] Code entered — advancing...');
        const btn = await getVisible(page, SEL.primaryBtn);
        if (btn) {
          await btn.click({ force: true }).catch(() => {});
        } else {
          await page.keyboard.press('Enter');
        }
        await sleep(500);
        try { await page.keyboard.press('Enter'); } catch (_) {}
        codeSent = true;
        await sleep(3000);
        continue;
      }

      // ── PROFILE_FORM ──────────────────────────────────────────────────────
      if (state === 'PROFILE_FORM') {
        if (!profileDone) {
          log(`[Session] Filling profile: ${displayName}`);
          const nameInput = await getVisible(page, SEL.displayName);
          if (nameInput) {
            await nameInput.click({ force: true }).catch(() => {});
            await nameInput.fill(displayName).catch(() => {});
            await sleep(300);
          }

          const ageInput = await getVisible(page, SEL.ageField);
          if (ageInput) {
            try {
              await ageInput.click({ force: true, timeout: 2000 });
              await ageInput.fill('19');
              await sleep(200);
            } catch (_) {
              try { await ageInput.fill('19'); } catch (__) {}
            }
          }
          try {
            const ageLabeled = page.getByLabel(/idade|age/i);
            if (await ageLabeled.isVisible()) {
              await ageLabeled.fill('19');
              await sleep(200);
            }
          } catch (_) {}

          await sleep(400);
          log('[Session] Profile filled — advancing...');
          profileDone = true;
        }

        const btn = await getVisible(page, SEL.primaryBtn);
        if (btn) await btn.click({ force: true }).catch(() => {});
        else await page.keyboard.press('Enter');
        await sleep(3000);
        continue;
      }

      // ── NEXT_BTN (interstitials, consent screens, welcome/continue modals) ───
      if (state === 'NEXT_BTN') {
        continueCycles++;
        if (continueCycles > 10) {
          log('[Session] Consecutive interstitials — sending Enter key and pausing...');
          await page.keyboard.press('Enter').catch(() => {});
          continueCycles = 0;
          await sleep(3000);
          continue;
        }

        let clicked = false;
        const btn = await getVisible(page, SEL.primaryBtn);
        if (btn) {
          log(`[Session] Advancing "Continuar" / primary button #${continueCycles}...`);
          try {
            await btn.click({ force: true, timeout: 3000 });
            clicked = true;
          } catch (_) {
            try {
              await btn.evaluate(b => b.click());
              clicked = true;
            } catch (__) {}
          }
          await sleep(2000);
        }

        if (!clicked) {
          try {
            const roleBtn = page.getByRole('button', { name: /continuar|continue|avançar|próximo|next|vamos|entendi|ok|concluir/i }).first();
            if (await roleBtn.isVisible({ timeout: 1500 })) {
              log(`[Session] Advancing role button "Continuar" #${continueCycles}...`);
              await roleBtn.click({ force: true });
              clicked = true;
              await sleep(2000);
            }
          } catch (_) {}
        }

        if (!clicked) {
          await page.keyboard.press('Enter').catch(() => {});
          await sleep(2000);
        }
        continue;
      }

      // ── LOADING / transition ──────────────────────────────────────────────
      unknownCycles++;
      if (unknownCycles > 20) {
        const title = await page.title().catch(() => '?');
        log(`[Session] Waiting... title: "${title}" url: ${page.url()}`);
        unknownCycles = 0;
        await sleep(5000);
      } else {
        await sleep(1500);
      }

      if (state !== 'LOADING') {
        unknownCycles = 0;
        continueCycles = 0;
      }
    }

  } catch (err) {
    log(`[Session] ✗ ${err.message}`);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

// ─── Resume or Create Persistent Session ──────────────────────────────────────

export async function resumeOrCreateSession(slot = 'active', log = console.log) {
  ensureSessionsDir();
  const statePath = path.join(SESSIONS_DIR, `${slot}_state.json`);
  const metaPath = path.join(SESSIONS_DIR, `${slot}_meta.json`);

  if (fs.existsSync(statePath) && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      log(`[Session] Found saved session for ${slot} (${meta.email}). Resuming...`);

      const browser = await createFreshBrowser();
      const ua = USER_AGENTS[0];
      const vp = VIEWPORTS[0];

      const context = await browser.newContext({
        storageState: statePath,
        userAgent: ua,
        viewport: vp,
        locale: 'pt-BR',
        extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      });

      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      });

      await page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2500);

      const state = await detectState(page);
      if (state === 'SESSION_READY') {
        log(`[Session] ✓ Session for ${meta.email} successfully resumed and ready!`);
        return { email: meta.email, page, context, browser, isResumed: true };
      } else {
        log(`[Session] Saved session expired or invalid (state: ${state}). Creating new one...`);
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    } catch (resumeErr) {
      log(`[Session] Could not resume session: ${resumeErr.message}. Creating new one...`);
    }
  }

  const session = await provisionSession(log);
  try {
    await session.context.storageState({ path: statePath });
    fs.writeFileSync(metaPath, JSON.stringify({ email: session.email, createdAt: new Date().toISOString() }, null, 2));
    log(`[Session] ✓ Session state saved to ${slot}_state.json`);
  } catch (saveErr) {
    log(`[Session] ⚠ Could not save session state: ${saveErr.message}`);
  }

  return { ...session, isResumed: false };
}

// ─── Kill-switch global da geração de imagens ────────────────────────────────
// Mantive o código do gerador (generateFallbackImage etc.) intacto — basta
// mudar para `true` para reativar no futuro.
const IMAGE_GENERATION_ENABLED = false;

// ─── Detecção rigorosa de pedido de geração de imagem ────────────────────────
// Remove código colado (fences ```, <script>, tags HTML, data URLs) antes de
// testar, e exige VERBO de criação + SUBSTANTIVO de imagem no texto limpo.
// Assim, um "melhore o visual do site" com código colado NÃO dispara o bloqueio,
// enquanto "crie uma imagem de um gato" dispara.
const IMG_GEN_VERB = /(?:crie|criem|cria\b|criar|gere|gerem|gera\b|gerar|desenhe|desenhem|desenha\b|desenhar|faça|fazer|produza|produzir|ilustre|ilustrar|monte|montar|renderize|renderizar|imagine|conceba|crear|create|generate|make|draw|design|paint|pinte|pintar)/i;
const IMG_NOUNS = /(?:imagem|imagens|image|images|foto|fotos|fotografia|ilustra(?:ção|ções|cao|coes)?|ilustration|logo|avatar|banner|wallpaper|arte\b|art\b|desenho|drawing|picture|painting|pôster|poster|retrato|portrait|capa)/i;

function isImageGenerationPrompt(text) {
  if (!text) return false;
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')          // blocos de código ``` ... ```
    .replace(/`[^`\n]*`/g, ' ')               // código inline
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')                 // tags HTML coladas
    .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return IMG_GEN_VERB.test(cleaned) && IMG_NOUNS.test(cleaned);
}

// ─── DOM → Markdown serializer ────────────────────────────────────────────────
// Roda dentro da página do ChatGPT. Converte a resposta renderizada do DOM para
// Markdown REAL (com cercas ``` código), evitando que innerText derrube as
// cercas e faça o frontend renderizar "código espalhado" em parágrafos <p>.
function domToMarkdown(root) {
  function ser(node) {
    if (node.nodeType === 3) {
      return node.textContent || '';
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();

    // Bloco de código: usa apenas o conteúdo do <code> (ignora botões Copiar)
    if (tag === 'pre') {
      const codeEl = node.querySelector('code');
      const codeText = (codeEl ? codeEl.textContent : node.textContent) || '';
      const langMatch = (codeEl?.getAttribute('class') || '').match(/language-([\w+-]+)/i);
      const lang = langMatch ? langMatch[1] : '';
      return `\n\`\`\`${lang}\n${codeText.replace(/\s+$/, '')}\n\`\`\`\n`;
    }

    if (tag === 'code') return '`' + node.textContent + '`';
    if (tag === 'br') return '\n';

    if (tag === 'img') return '';

    if (tag === 'button' || tag === 'svg' || tag === 'time') return '';

    const style = window.getComputedStyle(node);
    const isBlock = ['block', 'flex', 'grid'].includes(style.display) || ['p', 'div', 'section', 'article', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr'].includes(tag);

    let inner = '';
    for (const child of node.childNodes) {
      inner += ser(child);
    }

    switch (tag) {
      case 'h1': return `\n# ${inner.trim()}\n\n`;
      case 'h2': return `\n## ${inner.trim()}\n\n`;
      case 'h3': return `\n### ${inner.trim()}\n\n`;
      case 'h4': return `\n#### ${inner.trim()}\n\n`;
      case 'h5': return `\n##### ${inner.trim()}\n\n`;
      case 'h6': return `\n###### ${inner.trim()}\n\n`;
      case 'strong':
      case 'b': return `**${inner}**`;
      case 'em':
      case 'i': return `*${inner}*`;
      case 'del':
      case 's': return `~~${inner}~~`;
      case 'a': {
        const href = node.getAttribute('href') || '#';
        return `[${inner || href}](${href})`;
      }
      case 'li': return `${`- ${inner.trim()}`}\n`;
      case 'ul':
      case 'ol': return `\n${inner.replace(/\n+$/, '')}\n`;
      case 'table': return inner; // simplificado
      case 'tr': return inner.trim() ? `| ${inner.split(/\s*\|\s*/).filter(Boolean).join(' | ')} |\n` : '';
      case 'td':
      case 'th': return ` ${inner.trim()} |`;
      case 'blockquote': return `> ${inner.trim()}\n\n`;
      case 'hr': return `\n---\n`;
      default:
        // Bloco comum: adiciona separação para não grudar tudo
        if (isBlock) return inner.trim() ? `${inner}\n` : '';
        return inner;
    }
  }

  let out = '';
  for (const child of root.childNodes) {
    out += ser(child);
  }

  // Normaliza espaços em branco excessivos
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/(\s*\n){3,}/g, '\n\n')
    .trim();
}

// ─── Run query (Text + Image + Real-Time Chunk Streaming) ─────────────────────

export async function runQuery(page, message, image = null, historyContext = null, onChunk = null, log = console.log) {
  // ── Geração de imagens TEMPORARIAMENTE DESATIVADA ───────────────────────
  // Pedido real de criação de imagem → responde "em desenvolvimento" e NÃO
  // despacha nada para o ChatGPT (não consome cota nem trava a sessão).
  if (!IMAGE_GENERATION_ENABLED && isImageGenerationPrompt(message)) {
    log('[ImageGen] Pedido de geração bloqueado (recurso em desenvolvimento) — ChatGPT não acionado.');
    const aviso = '🎨 A criação de imagens ainda está em desenvolvimento e será liberada em breve. Por enquanto, posso analisar imagens que você enviar e ajudar com texto, código e ideias. Como posso ajudar?';
    if (typeof onChunk === 'function') onChunk(aviso);
    return { text: aviso, images: [], isLimited: false };
  }

  let input = await getVisible(page, SEL.targetInterface);

  if (!input) {
    for (const sel of SEL.targetInterface) {
      try {
        input = await page.waitForSelector(sel, { state: 'visible', timeout: 10000 });
        if (input) break;
      } catch (_) {}
    }
  }

  if (!input) throw new Error('Target interface input not found');

  // ── Handle image attachment ──────────────────────────────────────────────
  let tempFilePath = null;
  if (image) {
    try {
      let base64Data = '';
      let ext = 'png';

      if (typeof image === 'string') {
        if (image.includes(';base64,')) {
          const parts = image.split(';base64,');
          const mime = parts[0].split(':')[1];
          if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
          else if (mime.includes('webp')) ext = 'webp';
          else if (mime.includes('gif')) ext = 'gif';
          base64Data = parts[1];
        } else {
          base64Data = image;
        }
      } else if (typeof image === 'object' && image.dataUrl) {
        const parts = image.dataUrl.split(';base64,');
        if (parts.length === 2) {
          const mime = parts[0].split(':')[1] || '';
          if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
          else if (mime.includes('webp')) ext = 'webp';
          else if (mime.includes('gif')) ext = 'gif';
          base64Data = parts[1];
        } else {
          base64Data = image.dataUrl;
        }
      }

      if (base64Data) {
        tempFilePath = path.join(os.tmpdir(), `chat_upload_${Date.now()}.${ext}`);
        fs.writeFileSync(tempFilePath, Buffer.from(base64Data, 'base64'));

        log(`[Session] Uploading image (${ext})...`);

        let fileInput = await page.$('input[type="file"]');
        if (!fileInput) {
          const attachBtn = await page.$(
            'button[aria-label*="Attach" i], button[aria-label*="Anexar" i], button[aria-label*="Upload" i], [data-testid*="attach"]'
          );
          if (attachBtn) await attachBtn.click().catch(() => {});
          await sleep(400);
          fileInput = await page.$('input[type="file"]');
        }

        if (fileInput) {
          await fileInput.setInputFiles(tempFilePath);
          log('[Session] Image attached — awaiting preview upload...');
          await sleep(2500);
        } else {
          log('[Session] ⚠ Could not locate file input selector on ChatGPT');
        }
      }
    } catch (attachErr) {
      log(`[Session] ⚠ Image attach warning: ${attachErr.message}`);
    }
  }

  // ── Context Injection / Prompt composition ────────────────────────────────
  let userText = message && message.trim() ? message : (image ? 'Descreva ou processe esta imagem' : 'Olá');
  let finalPrompt = historyContext ? `${historyContext}\n\n[Mensagem Atual do Usuário]: ${userText}` : userText;

  // ── Image Request Detection ───────────────────────────────────────────────
  // Usa a detecção rigorosa (verbo + substantivo, ignorando código colado),
  // para que código/HTML colado com palavras como "image" não mude o polling.
  const isImageRequest = isImageGenerationPrompt(userText);

  // Read baseline message count BEFORE typing or dispatching
  const initialAssistantCount = await page.evaluate(() => {
    return document.querySelectorAll('[data-message-author-role="assistant"], article [data-message-author-role="assistant"], .agent-turn').length;
  }).catch(() => 0);

  // ── Enter prompt text ─────────────────────────────────────────────────────
  await input.click();
  await sleep(150);
  try {
    await input.fill(finalPrompt);
  } catch (_) {
    await page.keyboard.insertText(finalPrompt);
  }
  await sleep(300);

  // Send action
  let dispatched = false;
  try {
    const sendBtn = await page.waitForSelector(
      '[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Enviar" i]',
      { state: 'visible', timeout: 3000 }
    );
    if (sendBtn) {
      await sendBtn.click();
      dispatched = true;
    }
  } catch (_) {}

  if (!dispatched) await page.keyboard.press('Enter');

  if (tempFilePath) {
    try { fs.unlinkSync(tempFilePath); } catch (_) {}
  }

  log('[Session] Query dispatched — streaming response...');

  // ── IMAGE REQUEST: Instant Dedicated AI Generator (Zero widget delay, Zero percentage stalls) ──
  if (IMAGE_GENERATION_ENABLED && isImageRequest && !image) {
    log('[ImageGen] Image request detected — generating directly via high-speed AI engine (2s)...');
    if (typeof onChunk === 'function') {
      onChunk('🎨 Criando imagem com IA em alta resolução...');
    }
    const generated = await generateFallbackImage(userText, log);
    const responseText = 'Aqui está a imagem gerada de acordo com o seu pedido:';
    return { text: responseText, images: generated, isLimited: false };
  }

  // ── TEXT REQUEST: poll ChatGPT DOM normally ───────────────────────────────
  function cleanWidgetText(txt) {
    if (!txt) return '';
    return txt
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (!t) return true;
        // Remove apenas linhas que SÃO INTEIRAS um status de widget
        // (nunca apaga uma palavra solta dentro de um parágrafo ou código).
        return !/^(?:Editar|Edit|Finalizando|Criando imagem|Gerando imagem|Searching the web|Pesquisando|Thinking|Pensando|Finished|Creating image|\d{1,3}%)$/i.test(t);
      })
      .join('\n')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  }

  let lastStreamedText = '';
  let lastChangeTime = Date.now();
  const pollStart = Date.now();
  let doneStreaming = false;
  const maxWaitMs = 45000;

  while (!doneStreaming && Date.now() - pollStart < maxWaitMs) {
    await sleep(80);

    const snapshot = await page.evaluate((initCount) => {
      const assistantEls = document.querySelectorAll('[data-message-author-role="assistant"], article [data-message-author-role="assistant"], .agent-turn');
      const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i]');
      const hasStopBtn = !!(stopBtn && !stopBtn.disabled && (stopBtn.offsetWidth > 0 || stopBtn.offsetHeight > 0));
      const hasPulse = !!document.querySelector('.animate-pulse, [aria-label*="Generating" i], [aria-label*="Gerando" i], [data-testid*="image-generating"]');

      let hasImg = false;
      let rawText = '';
      if (assistantEls.length > 0) {
        const lastEl = assistantEls[assistantEls.length - 1];
        rawText = lastEl.innerText || lastEl.textContent || '';
        const imgs = lastEl.querySelectorAll('img');
        for (const im of imgs) {
          if (im.offsetWidth > 100 && im.offsetHeight > 100) {
            hasImg = true;
            break;
          }
        }
      }

      return {
        text: rawText,
        isGenerating: hasStopBtn || hasPulse,
        hasImg,
        hasEl: assistantEls.length > 0,
        count: assistantEls.length,
        isNew: assistantEls.length > initCount,
      };
    }, initialAssistantCount).catch(() => ({ text: '', isGenerating: false, hasImg: false, hasEl: false, count: 0, isNew: false }));

    const cleanedText = cleanWidgetText(snapshot.text);

    if (cleanedText && cleanedText !== lastStreamedText) {
      lastStreamedText = cleanedText;
      lastChangeTime = Date.now();
      if (typeof onChunk === 'function') {
        onChunk(cleanedText);
      }
    }

    // If image appeared in DOM, give 400ms to settle then complete
    if (snapshot.hasImg) {
      await sleep(400);
      doneStreaming = true;
      break;
    }

    // Done if not generating AND we have captured text or time elapsed
    const elapsed = Date.now() - pollStart;
    const textSettled = lastStreamedText.length > 0 && Date.now() - lastChangeTime > 2000;
    if (!isImageRequest) {
      if ((!snapshot.isGenerating && lastStreamedText.length > 0 && elapsed > 1000) || textSettled) {
        doneStreaming = true;
      }
    } else {
      // For image requests, if stop button disappeared and at least 6s elapsed
      if (!snapshot.isGenerating && elapsed > 6000) {
        doneStreaming = true;
      }
    }
  }

  const responseElements = await page.$$('[data-message-author-role="assistant"], article [data-message-author-role="assistant"], .agent-turn');
  let lastEl = responseElements.length > 0 ? responseElements[responseElements.length - 1] : null;

  // Captura o texto final. Prioriza o DOM serializado para Markdown (com
  // cercas ``` intactas), senão cai no innerText puro como fallback.
  let rawText = '';
  if (lastEl) {
    try {
      rawText = await lastEl.evaluate(domToMarkdown);
    } catch (_) {
      rawText = (await lastEl.innerText().catch(() => '')) || lastStreamedText;
    }
  } else {
    rawText = lastStreamedText || '';
  }

  let responseText = cleanWidgetText(rawText);

  // ── Extract generated images from ChatGPT DOM ───────────────────────────────
  let extractedImages = [];
  try {
    if (lastEl) {
      await sleep(300);
      const imgElements = await lastEl.$$('img');
      let bestImg = null;
      let maxArea = 0;

      for (const imgEl of imgElements) {
        try {
          const isVisible = await imgEl.isVisible().catch(() => false);
          if (!isVisible) continue;

          const box = await imgEl.boundingBox().catch(() => null);
          if (!box || box.width < 90 || box.height < 90) continue; // ignore avatars and icons

          const src = (await imgEl.getAttribute('src').catch(() => '')) || '';
          if (src.includes('avatar') || src.includes('profile') || src.includes('icon') || src.includes('user')) continue;

          const area = box.width * box.height;
          if (area > maxArea) {
            maxArea = area;
            bestImg = { imgEl, box, src };
          }
        } catch (_) {}
      }

      if (bestImg) {
        const alt = (await bestImg.imgEl.getAttribute('alt').catch(() => '')) || 'Imagem gerada pela IA';
        const buffer = await bestImg.imgEl.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null);
        const dataUrl = buffer ? `data:image/jpeg;base64,${buffer.toString('base64')}` : bestImg.src;

        extractedImages.push({
          src: dataUrl,
          dataUrl,
          alt,
          width: Math.round(bestImg.box.width),
          height: Math.round(bestImg.box.height),
        });
        log(`[Session] ✓ Best image extracted from DOM (${Math.round(bestImg.box.width)}x${Math.round(bestImg.box.height)}px, ${buffer ? Math.round(buffer.byteLength / 1024) + ' KB' : 'url'})`);
      }
    }
  } catch (imgExtractErr) {
    log(`[Session] Image extraction notice: ${imgExtractErr.message}`);
  }

  // ── Multi-Engine Fallback: If image requested but not captured in DOM ────────
  if (IMAGE_GENERATION_ENABLED && isImageRequest && extractedImages.length === 0) {
    log('[ImageGen] Image not found in DOM — triggering multi-engine fallback generator...');
    if (typeof onChunk === 'function') {
      onChunk('🎨 Renderizando imagem em alta resolução...');
    }
    extractedImages = await generateFallbackImage(userText, log);
  }

  // Clean companion text for image responses
  const isWidgetText = !responseText || responseText.length < 3 || /^(?:\s*Editar|\s*Edit|\s*Finalizando|\s*\d{1,3}%|\s*Criando imagem|\s*Gerando imagem)+\s*$/i.test(responseText);
  if (extractedImages.length > 0 && isWidgetText) {
    responseText = 'Aqui está a imagem gerada de acordo com o seu pedido:';
  }

  // Detect quota exhaustion signals
  const quotaSignals = [
    'upgrade to plus', 'assine o plus', "you've reached your limit",
    'atingiu seu limite', 'você atingiu', 'message limit', 'limite de mensagens',
    'free plan', 'plano gratuito', 'try again after', 'tente novamente após',
  ];
  const quotaHit = quotaSignals.some((p) => responseText.toLowerCase().includes(p));
  if (quotaHit) log('[Session] ⚠ Quota signal detected in response');

  return { text: responseText, images: extractedImages, isLimited: quotaHit };
}

/**
 * Bulletproof Multi-Engine Image Generator with redundant endpoints and automatic retry.
 */
export async function generateFallbackImage(prompt, log = console.log) {
  let cleanPrompt = prompt
    .replace(/\[INSTRUÇÃO DO SISTEMA:[^\]]+\]/gi, '')
    .replace(/\[Mensagem Atual do Usuário\]:/gi, '')
    .replace(/crie uma imagem (?:hiperrealista|realista|de|pra mim, de)?/gi, '')
    .replace(/gere uma imagem (?:hiperrealista|realista|de)?/gi, '')
    .replace(/desenhe (?:uma imagem de)?/gi, '')
    .replace(/faça uma imagem (?:de)?/gi, '')
    .trim();

  if (!cleanPrompt) cleanPrompt = prompt;

  const engines = [
    (p, s) => `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1024&height=1024&nologo=true&model=turbo&seed=${s}`,
    (p, s) => `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1024&height=1024&nologo=true&seed=${s}`,
    (p, s) => `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=1024&height=1024&nologo=true&model=flux&seed=${s}`,
  ];

  for (let i = 0; i < engines.length; i++) {
    try {
      const seed = Math.floor(Math.random() * 1000000);
      const url = engines[i](cleanPrompt, seed);
      log(`[ImageGen] Engine ${i + 1} generating: "${cleanPrompt.slice(0, 50)}..."`);

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 9000);

      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'image/jpeg,image/png,image/*;q=0.9',
        },
      });
      clearTimeout(tid);

      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.byteLength > 2000) {
          const base64 = buffer.toString('base64');
          const dataUrl = `data:image/jpeg;base64,${base64}`;
          log(`[ImageGen] ✓ Image successfully generated & downloaded (${Math.round(buffer.byteLength / 1024)} KB)`);
          return [{
            src: dataUrl,
            dataUrl,
            alt: cleanPrompt,
          }];
        }
      } else {
        log(`[ImageGen] Engine ${i + 1} returned status ${res.status}`);
      }
    } catch (err) {
      log(`[ImageGen] Engine ${i + 1} error: ${err.message}`);
    }
  }

  return [];
}

// Legacy aliases
export const createChatGPTAccount = provisionSession;
export const sendChatMessage = runQuery;

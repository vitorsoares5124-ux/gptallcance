// session.js (automation.js)
// Browser session provisioning for QA automation suite.
//
// DESIGN: screen-reader state machine — zero URL assumptions.
// Supports text queries and image attachments (Vision & DALL-E image generation).

import { chromium } from 'playwright';
import { createInboxAccount, waitForVerificationCode } from './tempmail.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
  const isHeadless = process.env.HEADLESS === 'true';
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

  const url = page.url();
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

  // Detect Cloudflare challenge (either via iframe or body content)
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

    while (true) {
      const state = await detectState(page);
      log(`[Session] State: ${state} | ${page.url()}`);

      // ── SESSION_READY ──────────────────────────────────────────────────────
      if (state === 'SESSION_READY') {
        log(`[Session] ✓ Interface confirmed. Inbox: ${email}`);
        return { email, page, context, browser };
      }

      // ── CHALLENGE_FORM (Cloudflare Turnstile) ─────────────────────────────
      if (state === 'CHALLENGE_FORM') {
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
        if (!clicked) {
          log('[Session] Waiting for challenge resolution...');
        }
        await sleep(4000);
        continue;
      }

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

          // Age/number field
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

      // ── NEXT_BTN (interstitials, consent screens, etc.) ───────────────────
      if (state === 'NEXT_BTN') {
        continueCycles++;
        if (continueCycles > 8) {
          log('[Session] Many consecutive interstitials — pausing...');
          continueCycles = 0;
          await sleep(5000);
          continue;
        }
        const btn = await getVisible(page, SEL.primaryBtn);
        if (btn) {
          log(`[Session] Advancing interstitial #${continueCycles}...`);
          await btn.click();
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
    await context.close();
    throw err;
  }
}

// ─── Run query (Text + Image support) ─────────────────────────────────────────

export async function runQuery(page, message, image = null, log = console.log) {
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

        // Check if file input is in DOM or trigger attach button
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
          // Give ChatGPT 2s to process the thumbnail upload
          await sleep(2500);
        } else {
          log('[Session] ⚠ Could not locate file input selector on ChatGPT');
        }
      }
    } catch (attachErr) {
      log(`[Session] ⚠ Image attach warning: ${attachErr.message}`);
    }
  }

  // ── Enter prompt text ─────────────────────────────────────────────────────
  await input.click();
  await sleep(200);

  const promptText = message && message.trim() ? message : (image ? 'Descreva ou processe esta imagem' : 'Olá');
  await input.fill(promptText);
  await sleep(400);

  // Send action
  let dispatched = false;
  try {
    const sendBtn = await page.waitForSelector(
      '[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Enviar" i]',
      { state: 'visible', timeout: 4000 }
    );
    if (sendBtn) {
      await sendBtn.click();
      dispatched = true;
    }
  } catch (_) {}

  if (!dispatched) await page.keyboard.press('Enter');

  // Clean up temp upload file
  if (tempFilePath) {
    try { fs.unlinkSync(tempFilePath); } catch (_) {}
  }

  log('[Session] Query dispatched — awaiting response...');

  // Record initial assistant count
  const initialAssistantCount = (await page.$$('[data-message-author-role="assistant"]')).length;

  // Wait for new response element to appear
  await page.waitForFunction(
    (initial) => document.querySelectorAll('[data-message-author-role="assistant"]').length > initial,
    initialAssistantCount,
    { timeout: 70000, polling: 500 }
  ).catch(() => {});

  // Wait for streaming to complete (stop button disappears)
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Parar" i]'),
    { timeout: 180000, polling: 1000 }
  ).catch(() => {});

  await sleep(800);

  const responseElements = await page.$$('[data-message-author-role="assistant"]');
  if (responseElements.length === 0) throw new Error('No response element found');

  const lastEl = responseElements[responseElements.length - 1];
  const responseText = await lastEl.innerText();

  // ── Extract generated images (DALL-E / Visual Outputs) ──────────────────────
  let extractedImages = [];
  try {
    extractedImages = await lastEl.$$eval('img', (imgs) => {
      return imgs
        .filter((img) => {
          const src = img.src || '';
          const alt = img.alt || '';
          // Filter out user avatars or system icons
          if (src.includes('avatar') || src.includes('profile') || src.includes('icon')) return false;
          if (img.width > 0 && img.width < 50 && img.height > 0 && img.height < 50) return false;
          return true;
        })
        .map((img) => ({
          src: img.src,
          alt: img.alt || 'Imagem gerada',
        }));
    });

    // Convert blob / CDN images to Base64 data URLs for seamless offline rendering
    for (const imgItem of extractedImages) {
      if (imgItem.src) {
        try {
          const dataUrl = await page.evaluate(async (url) => {
            const res = await fetch(url);
            const blob = await res.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
          }, imgItem.src);

          if (dataUrl) {
            imgItem.dataUrl = dataUrl;
          }
        } catch (_) {}
      }
    }
  } catch (imgExtractErr) {
    log(`[Session] Image extraction notice: ${imgExtractErr.message}`);
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

// Legacy aliases
export const createChatGPTAccount = provisionSession;
export const sendChatMessage = runQuery;

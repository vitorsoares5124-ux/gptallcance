// tempmail.js
// Custom Domain Catch-All System via ImprovMX & Gmail IMAP.
// Generates unlimited, clean @vaibly.com.br accounts that OpenAI never blacklists.
// Reads OTP codes directly from Gmail inbox in milliseconds using mailparser.

import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOMAIN = 'vaibly.com.br';
const GMAIL_USER = process.env.GMAIL_USER || 'vitorsoaresdrx@gmail.com';
const GMAIL_PASS = (process.env.GMAIL_APP_PASS || 'qsifaihpxvrlgnqe').replace(/\s+/g, '');

/**
 * Generates an infinite, clean email address under your custom domain.
 * Example: qa1827461@vaibly.com.br
 */
export async function createInboxAccount() {
  const username = `qa${Date.now().toString().slice(-7)}${Math.random().toString(36).slice(2, 5)}`;
  const email = `${username}@${DOMAIN}`;
  const createdAt = Date.now();

  return { email, username, domain: DOMAIN, createdAt };
}

/**
 * Connects to Gmail via IMAP to read the OpenAI 6-digit verification code.
 * Filters for messages sent to the target @vaibly.com.br address received after creation.
 * @param {object|string} inboxObj - { email, createdAt } or string email
 * @param {import('playwright').Page} chatPage - ChatGPT page instance
 */
export async function waitForVerificationCode(inboxObj, chatPage = null) {
  const targetEmail = (typeof inboxObj === 'object' ? inboxObj.email : inboxObj).toLowerCase();
  const minTimestamp = (typeof inboxObj === 'object' && inboxObj.createdAt)
    ? inboxObj.createdAt - 30000 // 30s buffer before creation
    : Date.now() - 60000;

  console.log(`[Inbox] Waiting for OpenAI code sent to: ${targetEmail}`);

  let waitSeconds = 0;
  let resendCount = 0;

  while (true) {
    await sleep(2000);
    waitSeconds += 2;

    // If code has not arrived after 10s, auto-click "Reenviar e-mail" on ChatGPT
    if (waitSeconds >= 10 && resendCount < 3 && chatPage) {
      resendCount++;
      console.log(`[Session] Code not received after 10s — clicking Resend on ChatGPT (attempt #${resendCount})...`);
      try {
        const resendBtn = await chatPage.$(
          'button:has-text("Reenviar"), button:has-text("Resend"), a:has-text("Reenviar"), a:has-text("Resend"), button.btn-secondary'
        );
        if (resendBtn) {
          await resendBtn.click({ force: true });
          console.log('[Session] ✓ Resend button clicked successfully.');
        } else {
          await chatPage.keyboard.press('Tab');
        }
      } catch (_) {}
      waitSeconds = 0;
    }

    try {
      const config = {
        imap: {
          user: GMAIL_USER,
          password: GMAIL_PASS,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          authTimeout: 6000,
          tlsOptions: { rejectUnauthorized: false },
        },
      };

      const connection = await imaps.connect(config);
      const box = await connection.openBox('INBOX');
      const total = box.messages.total;

      // Only search the latest 10 messages for high speed
      const startSeq = Math.max(1, total - 10);
      const fetchOptions = {
        bodies: [''],
        struct: true,
        markSeen: true,
      };

      const messages = await connection.search([`${startSeq}:${total}`], fetchOptions);
      // Sort descending: newest UID first
      messages.sort((a, b) => (b.attributes.uid || 0) - (a.attributes.uid || 0));

      for (const item of messages) {
        const rawPart = item.parts.find((p) => p.which === '');
        if (!rawPart || !rawPart.body) continue;

        const parsed = await simpleParser(rawPart.body);
        const msgDate = parsed.date ? new Date(parsed.date).getTime() : Date.now();

        // Must be received around or after this session started
        if (msgDate < minTimestamp) continue;

        // Check if delivered to our target email address
        const deliveredToHeader = parsed.headers.get('delivered-to');
        const deliveredToStr = Array.isArray(deliveredToHeader)
          ? deliveredToHeader.map(h => (typeof h === 'object' ? h.text || '' : String(h))).join(' ')
          : (typeof deliveredToHeader === 'object' ? deliveredToHeader?.text || '' : String(deliveredToHeader || ''));

        const toStr = (parsed.to?.text || '') + ' ' + deliveredToStr + ' ' + (parsed.text || '');

        const isMatchTarget = toStr.toLowerCase().includes(targetEmail);
        const isFromOpenAI = (parsed.from?.text || '').includes('openai.com') ||
                             (parsed.subject || '').toLowerCase().includes('chatgpt') ||
                             (parsed.subject || '').toLowerCase().includes('código') ||
                             (parsed.subject || '').toLowerCase().includes('codigo');

        if (isMatchTarget && isFromOpenAI) {
          // Extract 6-digit OTP code strictly from clean plain text body
          const cleanText = parsed.text || '';
          const match = cleanText.match(/\b(\d{6})\b/);
          if (match) {
            connection.end();
            console.log(`[Inbox] ✓ Code ${match[1]} extracted cleanly from Gmail for ${targetEmail}`);
            return match[1];
          }
        }
      }

      connection.end();
    } catch (err) {
      // Retry in next iteration
    }
  }
}

// Legacy aliases
export const createTempEmail = createInboxAccount;
export const waitForOTP = waitForVerificationCode;

// app.js — AllcanceAI frontend logic with Supabase Auth & Image Support

const SUPABASE_URL  = 'https://wlwnjhwgaygfjkxayyjc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indsd25qaHdnYXlnZmpreGF5eWpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTQyNzcsImV4cCI6MjEwNTI5MDI3N30.yJ40at7zGlDcXlat0XeNpy0CBkKPrwoAHcuv2S3sPv4';

// Initialize Supabase Client
const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON) : null;

// API endpoint configuration (supports Localhost, Vercel & Custom Tunnel/VPS)
function getApiEndpoint() {
  if (window.BACKEND_API) return window.BACKEND_API;
  const saved = localStorage.getItem('allcance_backend_url');
  if (saved) return saved.replace(/\/+$/, '');
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return window.location.origin;
}

let API = getApiEndpoint();

// ─── DOM refs ────────────────────────────────────────────────────────────────

// Auth elements
const authScreen      = document.getElementById('auth-screen');
const authForm        = document.getElementById('auth-form');
const authEmail       = document.getElementById('auth-email');
const authPassword    = document.getElementById('auth-password');
const authError       = document.getElementById('auth-error');
const authSubmitBtn   = document.getElementById('auth-submit-btn');
const authBtnText     = document.getElementById('auth-btn-text');
const authBtnSpinner  = document.getElementById('auth-btn-spinner');

// App elements
const appContainer    = document.getElementById('app-container');
const userEmailEl     = document.getElementById('user-email');
const logoutBtn       = document.getElementById('logout-btn');

const messagesEl      = document.getElementById('messages');
const emptyState      = document.getElementById('empty-state');
const form            = document.getElementById('chat-form');
const input           = document.getElementById('chat-input');
const sendBtn         = document.getElementById('send-btn');
const attachBtn       = document.getElementById('attach-btn');
const fileInput       = document.getElementById('file-input');
const previewContainer= document.getElementById('image-preview-container');
const previewImg      = document.getElementById('preview-img');
const removeImgBtn    = document.getElementById('remove-img-btn');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');

// Lightbox modal refs
const imageModal      = document.getElementById('image-modal');
const modalImg        = document.getElementById('modal-img');
const modalClose      = document.getElementById('modal-close');
const modalBackdrop   = document.getElementById('modal-backdrop');

// ─── State ───────────────────────────────────────────────────────────────────

let currentSession = null;
let isSending = false;
let selectedImage = null; // { dataUrl, name, size, type }
let eventSourceInstance = null;

// ─── Supabase Authentication ─────────────────────────────────────────────────

async function initAuth() {
  if (!supabase) {
    showApp({ user: { email: 'admin@allcance.ai' } });
    return;
  }

  // Check current session
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    showApp(session);
  } else {
    showAuth();
  }

  // Listen for auth state changes
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      showApp(session);
    } else {
      showAuth();
    }
  });
}

function showAuth() {
  currentSession = null;
  appContainer.classList.add('app-hidden');
  authScreen.classList.remove('auth-hidden');
  if (eventSourceInstance) {
    eventSourceInstance.close();
    eventSourceInstance = null;
  }
}

function showApp(session) {
  currentSession = session;
  authScreen.classList.add('auth-hidden');
  appContainer.classList.remove('app-hidden');

  if (session?.user?.email) {
    userEmailEl.textContent = session.user.email;
  }

  connectSSE();
  input.focus();
}

// Login form submission
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('auth-hidden');
  authError.textContent = '';

  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!email || !password) return;

  // Show loading
  authSubmitBtn.disabled = true;
  authBtnText.classList.add('auth-hidden');
  authBtnSpinner.classList.remove('auth-hidden');

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw error;
    }

    showApp(data.session);
  } catch (err) {
    authError.textContent = err.message === 'Invalid login credentials'
      ? 'E-mail ou senha incorretos. Verifique suas credenciais.'
      : (err.message || 'Erro ao realizar login.');
    authError.classList.remove('auth-hidden');
  } finally {
    authSubmitBtn.disabled = false;
    authBtnText.classList.remove('auth-hidden');
    authBtnSpinner.classList.add('auth-hidden');
  }
});

// Logout
logoutBtn.addEventListener('click', async () => {
  if (supabase) {
    await supabase.auth.signOut();
  }
  showAuth();
});

// ─── Status (SSE) ────────────────────────────────────────────────────────────

function updateStatus(status) {
  const dot = statusDot;
  const label = statusLabel;

  if (!status.active && !status.creatingStandby) {
    dot.className = 'status-dot error';
    label.textContent = 'Offline';
    return;
  }

  if (status.active) {
    if (status.standby) {
      dot.className = 'status-dot active';
      label.textContent = 'Pronto';
    } else if (status.creatingStandby) {
      dot.className = 'status-dot active';
      label.textContent = 'Pronto · preparando reserva';
    } else {
      dot.className = 'status-dot active';
      label.textContent = 'Pronto';
    }
  } else {
    dot.className = 'status-dot creating';
    label.textContent = 'Inicializando...';
  }
}

function handleRotating() {
  statusDot.className = 'status-dot rotating';
  statusLabel.textContent = 'Trocando conta...';
  addRotationNotice();
}

function connectSSE() {
  if (eventSourceInstance) {
    eventSourceInstance.close();
  }

  try {
    eventSourceInstance = new EventSource(`${API}/status/stream`);

    eventSourceInstance.addEventListener('status', (e) => {
      try {
        const status = JSON.parse(e.data);
        updateStatus(status);
      } catch (_) {}
    });

    eventSourceInstance.addEventListener('log', (e) => {
      try {
        const { line } = JSON.parse(e.data);
        if (line.includes('Rotating') || line.includes('rotated') || line.includes('rotating')) {
          handleRotating();
        }
      } catch (_) {}
    });

    eventSourceInstance.onerror = () => {
      statusDot.className = 'status-dot error';
      statusLabel.textContent = 'Reconectando...';
    };
  } catch (_) {}
}

// ─── Image Attachment & Clipboard Handling ───────────────────────────────────

function compressImage(file, maxDimension = 1600, quality = 0.88) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const dataUrl = canvas.toDataURL(mime, quality);
        resolve({
          dataUrl,
          name: file.name || 'image.jpg',
          type: mime,
        });
      };
      img.onerror = () => {
        resolve({
          dataUrl: e.target.result,
          name: file.name || 'image.png',
          type: file.type,
        });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleImageSelected(file) {
  if (!file || !file.type.startsWith('image/')) return;

  const processed = await compressImage(file);
  selectedImage = processed;
  previewImg.src = selectedImage.dataUrl;
  previewContainer.classList.remove('preview-hidden');
  input.focus();
}

function clearImage() {
  selectedImage = null;
  previewImg.src = '';
  previewContainer.classList.add('preview-hidden');
  fileInput.value = '';
}

attachBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleImageSelected(e.target.files[0]);
  }
});

removeImgBtn.addEventListener('click', clearImage);

// Paste screenshot directly (Ctrl+V)
window.addEventListener('paste', (e) => {
  if (!currentSession) return;
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        handleImageSelected(file);
        break;
      }
    }
  }
});

// Drag & Drop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!currentSession) return;
  e.preventDefault();
  if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
    handleImageSelected(e.dataTransfer.files[0]);
  }
});

// ─── Lightbox Modal ──────────────────────────────────────────────────────────

function openLightbox(src) {
  modalImg.src = src;
  imageModal.classList.remove('modal-hidden');
}

function closeLightbox() {
  imageModal.classList.add('modal-hidden');
  modalImg.src = '';
}

modalClose.addEventListener('click', closeLightbox);
modalBackdrop.addEventListener('click', closeLightbox);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// ─── Textarea auto-resize ─────────────────────────────────────────────────────

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isSending && (input.value.trim() || selectedImage)) {
      form.requestSubmit();
    }
  }
});

// ─── Message rendering ───────────────────────────────────────────────────────

function parseMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // Bold & italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g,     '<em>$1</em>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/((?:^[•\-\*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[•\-\*] /, '')}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^\d+\. /, '')}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs
  html = html.replace(/^(?!<[houplais]|<pre|<hr)(.+)$/gm, (line) => {
    if (line.trim()) return `<p>${line}</p>`;
    return '';
  });

  return html;
}

function addMessage(role, text, imageAttachment = null, generatedImages = []) {
  emptyState.setAttribute('aria-hidden', 'true');

  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.setAttribute('role', 'article');
  el.setAttribute('aria-label', role === 'user' ? 'Você' : 'AllcanceAI');

  if (role === 'user') {
    const userContent = document.createElement('div');
    userContent.className = 'user-content';

    if (imageAttachment) {
      const img = document.createElement('img');
      img.src = imageAttachment.dataUrl || imageAttachment;
      img.className = 'message-img';
      img.alt = 'Imagem enviada';
      img.addEventListener('click', () => openLightbox(img.src));
      userContent.appendChild(img);
    }

    if (text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      userContent.appendChild(bubble);
    }

    el.appendChild(userContent);
  } else {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = parseMarkdown(text);

    if (generatedImages && generatedImages.length > 0) {
      for (const genImg of generatedImages) {
        const wrap = document.createElement('div');
        wrap.className = 'message-image-wrapper';
        const img = document.createElement('img');
        img.src = genImg.dataUrl || genImg.src;
        img.alt = genImg.alt || 'Imagem gerada pela IA';
        img.className = 'message-img';
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(img.src));
        wrap.appendChild(img);
        bubble.appendChild(wrap);
      }
    }

    el.appendChild(bubble);
  }

  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addTypingIndicator() {
  const el = document.createElement('div');
  el.className = 'message ai typing';
  el.id = 'typing-indicator';
  el.innerHTML = `<div class="bubble">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function removeTypingIndicator() {
  document.getElementById('typing-indicator')?.remove();
}

function addRotationNotice() {
  const el = document.createElement('div');
  el.className = 'message rotation-notice';
  el.textContent = 'conta renovada';
  messagesEl.appendChild(el);
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const main = document.getElementById('chat-main');
    main.scrollTop = main.scrollHeight;
  });
}

// ─── Send ─────────────────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const message = input.value.trim();
  const currentImage = selectedImage;

  if ((!message && !currentImage) || isSending) return;

  isSending = true;
  sendBtn.disabled = true;

  input.value = '';
  input.style.height = 'auto';
  clearImage();

  addMessage('user', message, currentImage);
  addTypingIndicator();

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentSession?.access_token) {
      headers['Authorization'] = `Bearer ${currentSession.access_token}`;
    }
    if (currentSession?.user?.id) {
      headers['X-User-Id'] = currentSession.user.id;
    }

    const res = await fetch(`${API}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message,
        image: currentImage ? currentImage.dataUrl : null,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    removeTypingIndicator();
    addMessage('ai', data.text, null, data.images || []);

  } catch (err) {
    removeTypingIndicator();
    addMessage('ai', `Erro: ${err.message}`);
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    input.focus();
  }
});

// ─── Init Auth ────────────────────────────────────────────────────────────────

initAuth();

// app.js — AllcanceAI frontend logic with Multi-Conversation History & Robust Supabase Auth

const SUPABASE_URL  = 'https://wlwnjhwgaygfjkxayyjc.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indsd25qaHdnYXlnZmpreGF5eWpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTQyNzcsImV4cCI6MjEwNTI5MDI3N30.yJ40at7zGlDcXlat0XeNpy0CBkKPrwoAHcuv2S3sPv4';

// Dynamic Supabase Client instance
let _supabaseClient = null;

async function getSupabase() {
  if (_supabaseClient) return _supabaseClient;

  // If window.supabase is not loaded yet, wait up to 4s
  let attempts = 0;
  while (!window.supabase && attempts < 20) {
    await new Promise((r) => setTimeout(r, 200));
    attempts++;
  }

  if (window.supabase && typeof window.supabase.createClient === 'function') {
    _supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
    return _supabaseClient;
  }
  return null;
}

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
const authScreen       = document.getElementById('auth-screen');
const authForm         = document.getElementById('auth-form');
const authEmail        = document.getElementById('auth-email');
const authPassword     = document.getElementById('auth-password');
const authError        = document.getElementById('auth-error');
const authSubmitBtn    = document.getElementById('auth-submit-btn');
const authBtnText      = document.getElementById('auth-btn-text');
const authBtnSpinner   = document.getElementById('auth-btn-spinner');

// App elements
const appContainer     = document.getElementById('app-container');
const userEmailEl      = document.getElementById('user-email');
const sidebarUserEmail = document.getElementById('sidebar-user-email');
const logoutBtn        = document.getElementById('logout-btn');

// Sidebar elements
const chatSidebar      = document.getElementById('chat-sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const sidebarBackdrop  = document.getElementById('sidebar-backdrop');
const newChatBtn       = document.getElementById('new-chat-btn');
const conversationsList= document.getElementById('conversations-list');

// Chat area elements
const messagesEl       = document.getElementById('messages');
const emptyState       = document.getElementById('empty-state');
const form             = document.getElementById('chat-form');
const input            = document.getElementById('chat-input');
const sendBtn          = document.getElementById('send-btn');
const attachBtn        = document.getElementById('attach-btn');
const fileInput        = document.getElementById('file-input');
const previewContainer = document.getElementById('image-preview-container');
const previewImg       = document.getElementById('preview-img');
const removeImgBtn     = document.getElementById('remove-img-btn');
const statusDot        = document.getElementById('status-dot');
const statusLabel      = document.getElementById('status-label');

// Lightbox modal refs
const imageModal       = document.getElementById('image-modal');
const modalImg         = document.getElementById('modal-img');
const modalClose       = document.getElementById('modal-close');
const modalBackdrop    = document.getElementById('modal-backdrop');

// ─── State ───────────────────────────────────────────────────────────────────

let currentSession = null;
let currentUserId = 'anonymous';
let isSending = false;
let selectedImage = null; // { dataUrl, name, size, type }
let eventSourceInstance = null;

// Multi-chat state
let conversations = []; // [ { id, title, createdAt, updatedAt, messages: [] } ]
let activeConversationId = null;

// ─── Supabase Authentication ─────────────────────────────────────────────────

async function initAuth() {
  const sb = await getSupabase();
  if (!sb) {
    console.warn('[Auth] Supabase library not available, fallback to direct access.');
    showApp({ user: { id: 'admin_local', email: 'admin@allcance.ai' } });
    return;
  }

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) {
      showApp(session);
    } else {
      showAuth();
    }
  } catch (_) {
    showAuth();
  }

  sb.auth.onAuthStateChange((_event, session) => {
    if (session && session.user) {
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
  currentUserId = session?.user?.id || 'anonymous';
  authScreen.classList.add('auth-hidden');
  appContainer.classList.remove('app-hidden');

  const email = session?.user?.email || 'Usuário';
  if (userEmailEl) userEmailEl.textContent = email;
  if (sidebarUserEmail) sidebarUserEmail.textContent = email;

  loadConversations();
  connectSSE();
  input.focus();
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  e.stopPropagation();

  authError.classList.add('auth-hidden');
  authError.textContent = '';

  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!email || !password) {
    authError.textContent = 'Preencha o e-mail e a senha.';
    authError.classList.remove('auth-hidden');
    return;
  }

  authSubmitBtn.disabled = true;
  authBtnText.classList.add('auth-hidden');
  authBtnSpinner.classList.remove('auth-hidden');

  try {
    const sb = await getSupabase();
    if (!sb) {
      throw new Error('Não foi possível conectar ao servidor de autenticação Supabase.');
    }

    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw error;
    }

    if (!data.session) {
      throw new Error('Sessão não iniciada. Verifique se o e-mail foi confirmado no Supabase.');
    }

    showApp(data.session);
  } catch (err) {
    console.error('[Auth] Login error:', err);
    let msg = err.message || 'Erro ao realizar login.';
    if (msg.includes('Invalid login credentials')) {
      msg = 'E-mail ou senha incorretos. Verifique suas credenciais.';
    } else if (msg.includes('Email not confirmed')) {
      msg = 'E-mail não confirmado no Supabase. Marque o e-mail como confirmado no painel.';
    }
    authError.textContent = msg;
    authError.classList.remove('auth-hidden');
  } finally {
    authSubmitBtn.disabled = false;
    authBtnText.classList.remove('auth-hidden');
    authBtnSpinner.classList.add('auth-hidden');
  }
});

logoutBtn.addEventListener('click', async () => {
  const sb = await getSupabase();
  if (sb) {
    await sb.auth.signOut().catch(() => {});
  }
  showAuth();
});

// ─── Multi-Conversation Storage & Manager ────────────────────────────────────

function getStorageKey() {
  return `allcance_conversations_${currentUserId}`;
}

function loadConversations() {
  try {
    const data = localStorage.getItem(getStorageKey());
    conversations = data ? JSON.parse(data) : [];
  } catch (_) {
    conversations = [];
  }

  if (conversations.length > 0) {
    switchToConversation(conversations[0].id);
  } else {
    startNewChat();
  }
  renderConversationsList();
}

function saveConversations() {
  try {
    localStorage.setItem(getStorageKey(), JSON.stringify(conversations));
  } catch (_) {}
  renderConversationsList();
}

function startNewChat() {
  activeConversationId = null;
  messagesEl.innerHTML = '';
  emptyState.setAttribute('aria-hidden', 'false');
  clearImage();
  renderConversationsList();
  input.focus();

  if (window.innerWidth <= 768) {
    appContainer.classList.remove('sidebar-mobile-open');
  }
}

function switchToConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;

  activeConversationId = id;
  messagesEl.innerHTML = '';
  emptyState.setAttribute('aria-hidden', 'true');

  for (const msg of conv.messages) {
    renderMessageInDOM(msg.role, msg.text, msg.imageAttachment, msg.generatedImages);
  }

  renderConversationsList();
  scrollToBottom();

  if (window.innerWidth <= 768) {
    appContainer.classList.remove('sidebar-mobile-open');
  }
  input.focus();
}

function deleteConversation(e, id) {
  e.stopPropagation();
  conversations = conversations.filter(c => c.id !== id);
  saveConversations();

  if (activeConversationId === id) {
    if (conversations.length > 0) {
      switchToConversation(conversations[0].id);
    } else {
      startNewChat();
    }
  }
}

function renderConversationsList() {
  if (!conversationsList) return;
  conversationsList.innerHTML = '';

  if (conversations.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '12px 10px';
    emptyMsg.style.fontSize = '12px';
    emptyMsg.style.color = 'rgba(255,255,255,0.3)';
    emptyMsg.textContent = 'Nenhuma conversa salva';
    conversationsList.appendChild(emptyMsg);
    return;
  }

  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item ${conv.id === activeConversationId ? 'active' : ''}`;
    item.addEventListener('click', () => switchToConversation(conv.id));

    const titleSpan = document.createElement('span');
    titleSpan.className = 'conversation-title-text';
    titleSpan.textContent = conv.title || 'Conversa';

    const delBtn = document.createElement('button');
    delBtn.className = 'conversation-delete-btn';
    delBtn.title = 'Excluir conversa';
    delBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `;
    delBtn.addEventListener('click', (e) => deleteConversation(e, conv.id));

    item.appendChild(titleSpan);
    item.appendChild(delBtn);
    conversationsList.appendChild(item);
  }
}

// Sidebar toggle buttons
newChatBtn.addEventListener('click', startNewChat);

toggleSidebarBtn.addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    appContainer.classList.toggle('sidebar-mobile-open');
  } else {
    appContainer.classList.toggle('sidebar-closed');
  }
});

sidebarBackdrop.addEventListener('click', () => {
  appContainer.classList.remove('sidebar-mobile-open');
});

// ─── Status (SSE & REST) ────────────────────────────────────────────────────

function updateStatus(status) {
  if (!statusDot || !statusLabel) return;

  if (status && status.active) {
    statusDot.className = 'status-dot active';
    statusLabel.textContent = 'Pronto';
  } else {
    statusDot.className = 'status-dot creating';
    statusLabel.textContent = 'Conectando aos servidores...';
  }
}

function handleRotating() {
  if (statusDot) statusDot.className = 'status-dot rotating';
  if (statusLabel) statusLabel.textContent = 'Renovando conexão...';
  addRotationNotice();
}

async function checkInitialStatus() {
  try {
    const res = await fetch(`${API}/status`);
    if (res.ok) {
      const data = await res.json();
      updateStatus(data);
    }
  } catch (_) {}
}

function connectSSE() {
  if (eventSourceInstance) eventSourceInstance.close();

  checkInitialStatus();

  try {
    eventSourceInstance = new EventSource(`${API}/status/stream`);

    eventSourceInstance.addEventListener('status', (e) => {
      try { updateStatus(JSON.parse(e.data)); } catch (_) {}
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
      if (statusDot) statusDot.className = 'status-dot creating';
      if (statusLabel) statusLabel.textContent = 'Conectando aos servidores...';
    };
  } catch (_) {
    if (statusDot) statusDot.className = 'status-dot creating';
    if (statusLabel) statusLabel.textContent = 'Conectando aos servidores...';
  }
}

// ─── Image Attachment & Compression ──────────────────────────────────────────

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

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleImageSelected(e.target.files[0]);
  }
});

removeImgBtn.addEventListener('click', clearImage);

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

  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g,     '<em>$1</em>');
  html = html.replace(/^---+$/gm, '<hr>');

  html = html.replace(/((?:^[•\-\*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[•\-\*] /, '')}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^\d+\. /, '')}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  html = html.replace(/^(?!<[houplais]|<pre|<hr)(.+)$/gm, (line) => {
    if (line.trim()) return `<p>${line}</p>`;
    return '';
  });

  return html;
}

function renderMessageInDOM(role, text, imageAttachment = null, generatedImages = []) {
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
  el.textContent = 'conta renovada · contexto preservado';
  messagesEl.appendChild(el);
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const main = document.getElementById('chat-main');
    main.scrollTop = main.scrollHeight;
  });
}

// ─── Send Form Handler ────────────────────────────────────────────────────────

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

  let conv = conversations.find(c => c.id === activeConversationId);
  if (!conv) {
    const newId = `conv_${Date.now()}`;
    const autoTitle = (message || 'Análise de imagem').slice(0, 28);
    conv = {
      id: newId,
      title: autoTitle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    conversations.unshift(conv);
    activeConversationId = newId;
    saveConversations();
  }

  const userMsgObj = {
    role: 'user',
    text: message,
    imageAttachment: currentImage ? currentImage.dataUrl : null,
    timestamp: new Date().toISOString(),
  };

  conv.messages.push(userMsgObj);
  conv.updatedAt = new Date().toISOString();
  saveConversations();

  renderMessageInDOM('user', message, currentImage);
  addTypingIndicator();

  const historyPayload = conv.messages.slice(-15).map(m => ({
    role: m.role,
    text: m.text || (m.imageAttachment ? '[Imagem enviada]' : ''),
  }));

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (currentSession?.access_token) {
      headers['Authorization'] = `Bearer ${currentSession.access_token}`;
    }
    if (currentUserId) {
      headers['X-User-Id'] = currentUserId;
    }

    const res = await fetch(`${API}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message,
        image: currentImage ? currentImage.dataUrl : null,
        conversationId: activeConversationId,
        history: historyPayload,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    removeTypingIndicator();

    const aiMsgObj = {
      role: 'ai',
      text: data.text,
      generatedImages: data.images || [],
      timestamp: new Date().toISOString(),
    };

    conv.messages.push(aiMsgObj);
    conv.updatedAt = new Date().toISOString();
    saveConversations();

    renderMessageInDOM('ai', data.text, null, data.images || []);

  } catch (err) {
    removeTypingIndicator();
    renderMessageInDOM('ai', `Erro: ${err.message}`);
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    input.focus();
  }
});

// ─── Init Auth on DOM ready ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initAuth);
if (document.readyState !== 'loading') {
  initAuth();
}

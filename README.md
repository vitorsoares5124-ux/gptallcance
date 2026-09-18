# AllcanceAI — High Performance AI Engine & Chat Interface

Motor autônomo com rotação contínua de sessões ChatGPT, autenticação via Supabase, suporte a envio de imagens (Vision) e renderização de imagens geradas (DALL-E).

---

## ⚡ Recursos

- **Rotação Contínua & Sem Interrupções:** Mantém sempre uma sessão ativa (`active`) e uma sessão pré-aquecida (`standby`). Quando a cota estoura, a rotação é instantânea.
- **Domínio Próprio Catch-All (`@vaibly.com.br`):** Contas infinitas e limpas geradas em milissegundos via ImprovMX e IMAP.
- **Suporte a Imagens Completo:**
  - Envio de imagens por botão de anexo, Drag & Drop ou colar direto da área de transferência (`Ctrl+V`).
  - Extração e renderização de imagens geradas pelo ChatGPT (DALL-E).
  - Lightbox modal para visualização em alta resolução.
- **Autenticação Segura (Supabase):** Tela de login protegida integrada com Supabase Auth.
- **Design Minimalista & Responsivo:** True Black, Syne, IBM Plex Mono & IBM Plex Sans.

---

## 🚀 Instalação & Execução Local

### 1. Instalar dependências

```bash
cd backend
npm install
npx playwright install chromium
```

### 2. Executar

```bash
npm start
```

O servidor Express inicializa na porta `3000` e serve o frontend automaticamente em `http://localhost:3000`.

---

## 🌐 Deploy na Nuvem

- **Frontend (Vercel):**
  - Publique a pasta `frontend/` na Vercel.
  - No `app.js`, defina `window.BACKEND_API = 'https://sua-api.com'` ou utilize a rota relativa se estiver com proxy reverso.
- **Backend (VPS / Render / Railway):**
  - Execute a pasta `backend/` em um ambiente Node com suporte a Chromium (ex: Dockerfile com Playwright ou VPS Ubuntu).

---

## 📁 Estrutura

```
rotate/
  backend/
    server.js          ← Express + SSE + Image Payload
    accountManager.js  ← Gerenciamento do Pool e Rotação
    automation.js      ← Playwright: Criação de conta + Chat + Vision + DALL-E
    tempmail.js        ← IMAP Catch-All OTP Parser (Mailparser)
    package.json
  frontend/
    index.html         ← UI do Chat + Tela de Login Supabase + Modal
    style.css          ← Design System (True Black)
    app.js             ← Supabase Auth + SSE + Image & Chat Logic
    assets/
      logo.jpg
```

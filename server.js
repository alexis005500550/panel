// ═══════════════════════════════════════════════════════════════════
//  PushProspect — Proxy Gemini + Persistance disque + WhatsApp Auto
//  node server.js
// ═══════════════════════════════════════════════════════════════════
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
try { require('dotenv').config(); } catch(e) {}

const HTML = fs.readFileSync('./index.html', 'utf8');
const API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY manquante'); process.exit(1); }
const PORT = process.env.PORT || 8080;
const MODEL = 'gemini-2.5-flash-lite';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_XXXX';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const PLANS = {
  free:     { id:'free',     name:'Gratuit',       credits: 15,      price: 0,   priceId: null },
  starter:  { id:'starter',  name:'Starter',       credits: 250,     price: 25,  priceId: 'price_starter' },
  pro:      { id:'pro',      name:'Pro',            credits: 500,     price: 50,  priceId: 'price_pro' },
  business: { id:'business', name:'Business',       credits: 1500,    price: 150, priceId: 'price_business' },
  agency:   { id:'agency',   name:'Agence',         credits: 999999,  price: 0,   priceId: null },
};



if (!global._rateLimitMap) global._rateLimitMap = new Map();
const DATA_DIR = path.join(__dirname, 'data');
const WA_DIR   = path.join(__dirname, 'wa_session');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WA_DIR))   fs.mkdirSync(WA_DIR,   { recursive: true });

// ══ GMAIL OAuth — constantes et helpers (hors serveur, c'est correct ici) ══
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT_URI  = `http://localhost:${PORT}/gmail/callback`;
const GMAIL_TOKEN_FILE    = path.join(DATA_DIR, 'gmail_token.json');

// ══ CREDITS ══
function getTeamCredits(teamId) {
  const credits = readDB('credits') || [];
  const entry = credits.find(c => c.teamId === teamId);
  if (!entry) return null;
  return entry;
}

function addCredits(teamId, amount, reason, plan) {
  const credits = readDB('credits') || [];
  let entry = credits.find(c => c.teamId === teamId);
  if (!entry) {
    entry = { teamId, balance: 0, totalBought: 0, plan: 'free', history: [] };
    credits.push(entry);
  }
  entry.balance = (entry.balance || 0) + amount;
  entry.totalBought = (entry.totalBought || 0) + amount;
  if (plan) entry.plan = plan;
  if (!entry.history) entry.history = [];
  entry.history.push({
    type: 'credit', amount, reason: reason || 'Rechargement',
    date: new Date().toISOString(), balanceAfter: entry.balance
  });
  writeDB('credits', credits);
  return entry;
}

function consumeCredit(teamId, count) {
  count = count || 1;
  const credits = readDB('credits') || [];
  let entry = credits.find(c => c.teamId === teamId);
  if (!entry) return { ok: false, error: 'Aucun crédit trouvé' };
  if (entry.plan === 'agency') return { ok: true, balance: 999999 };
  if ((entry.balance || 0) < count) return { ok: false, error: 'Crédits insuffisants', balance: entry.balance || 0 };
  entry.balance -= count;
  if (!entry.history) entry.history = [];
  entry.history.push({
    type: 'debit', amount: -count, reason: `${count} lead(s) scanné(s)`,
    date: new Date().toISOString(), balanceAfter: entry.balance
  });
  writeDB('credits', credits);
  return { ok: true, balance: entry.balance };
}

function initFreeCredits(teamId) {
  const credits = readDB('credits') || [];
  let entry = credits.find(c => c.teamId === teamId);
  if (!entry) {
    entry = {
      teamId, balance: 15, totalBought: 15, plan: 'free',
      history: [{
        type: 'credit', amount: 15, reason: 'Offre gratuite',
        date: new Date().toISOString(), balanceAfter: 15
      }]
    };
    credits.push(entry);
    writeDB('credits', credits);
  }
  return entry;
}

function readGmailToken() {
  try { if (fs.existsSync(GMAIL_TOKEN_FILE)) return JSON.parse(fs.readFileSync(GMAIL_TOKEN_FILE, 'utf8')); }
  catch(e) {}
  return null;
}
function saveGmailToken(token) {
  fs.writeFileSync(GMAIL_TOKEN_FILE, JSON.stringify(token), 'utf8');
}

// ── DB ──────────────────────────────────────────────────────────────
const DB_FILES = {
  contacts    : path.join(DATA_DIR, 'contacts.json'),
  users       : path.join(DATA_DIR, 'users.json'),
  agenda      : path.join(DATA_DIR, 'agenda.json'),
  blocked     : path.join(DATA_DIR, 'blocked.json'),
  activity    : path.join(DATA_DIR, 'activity.json'),
  messages    : path.join(DATA_DIR, 'messages.json'),
  teams       : path.join(DATA_DIR, 'teams.json'),
  rdv         : path.join(DATA_DIR, 'rdv.json'),
  emails      : path.join(DATA_DIR, 'emails.json'),
  affiliates  : path.join(DATA_DIR, 'affiliates.json'),
  deposits    : path.join(DATA_DIR, 'deposits.json'),
  payouts     : path.join(DATA_DIR, 'payouts.json'),
  credits     : path.join(DATA_DIR, 'credits.json'),
};
function readDB(key) {
  const defaultSuperAdmin = [{
    id: 'superadmin', login: 'superadmin', name: 'Super Admin',
    pass: 'superadmin123', role: 'superadmin', teamId: null,
    created: new Date().toISOString().split('T')[0]
  }];
  try {
    if (fs.existsSync(DB_FILES[key])) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILES[key], 'utf8'));
      if (key === 'users') {
        if (!Array.isArray(parsed) || parsed.length === 0) return defaultSuperAdmin;
        // S'assurer que le superadmin est toujours présent
        const hasSuperAdmin = parsed.some(u => u.role === 'superadmin');
        if (!hasSuperAdmin) return [...defaultSuperAdmin, ...parsed];
        return parsed;
      }
      return parsed;
    }
  } catch (e) { console.error('readDB error', key, e.message); }
  if (key === 'users') return defaultSuperAdmin;
  if (key === 'teams') return [];
  return [];
}
function writeDB(key, data) {
  try { fs.writeFileSync(DB_FILES[key], JSON.stringify(data, null, 2), 'utf8'); return true; }
  catch (e) { console.error('writeDB error', key, e.message); return false; }
}

// ══════════════════════════════════════════════════════════════════
//  WHATSAPP via whatsapp-web.js
// ══════════════════════════════════════════════════════════════════
//const { Client, LocalAuth } = require('whatsapp-web.js');
let waClient = null;
let waStatus = 'disconnected';
let waQR     = null;

async function initWhatsApp() {
  waStatus = 'connecting';
  console.log('  📱 Initialisation WhatsApp...');

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: WA_DIR }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  waClient.on('qr', (qr) => {
    waQR     = qr;
    waStatus = 'qr';
    console.log('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  📱  SCANNEZ LE QR CODE WHATSAPP');
    console.log('  👉  http://localhost:' + PORT + '/wa/qr');
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    try { require('qrcode-terminal').generate(qr, { small: true }); } catch(e) {}
  });

  waClient.on('ready', () => {
    waStatus = 'connected';
    waQR     = null;
    const info = waClient.info;
    console.log(`  ✅ WhatsApp connecté : ${info?.pushname || ''} (${info?.wid?.user || ''})`);
  });

  waClient.on('authenticated', () => {
    console.log('  🔐 WhatsApp authentifié — session sauvegardée');
  });

  waClient.on('auth_failure', (msg) => {
    waStatus = 'disconnected';
    console.error('  ✗ Échec authentification WhatsApp:', msg);
    try { fs.rmSync(WA_DIR, { recursive: true, force: true }); fs.mkdirSync(WA_DIR, { recursive: true }); } catch(e) {}
    setTimeout(initWhatsApp, 5000);
  });

  waClient.on('disconnected', (reason) => {
    waStatus = 'disconnected';
    waClient = null;
    waQR     = null;
    console.log(`  ⚠️  WhatsApp déconnecté (${reason}). Reconnexion dans 10s...`);
    setTimeout(initWhatsApp, 10000);
  });

  try {
    await waClient.initialize();
  } catch(e) {
    console.error('  ✗ Erreur init WhatsApp:', e.message);
    waStatus = 'disconnected';
    waClient = null;
    setTimeout(initWhatsApp, 15000);
  }
}


// ══ TELEGRAM NOTIFICATIONS ══
function sendTelegram(message) {
  const TELEGRAM_BOT = '8512389683:AAGjagjTheVhiaYrj6by6ZLnoPUNcFRSINU';
  const TELEGRAM_USER = '5899192308';
  const text = encodeURIComponent(message);
  const path = `/bot${TELEGRAM_BOT}/sendMessage?chat_id=${TELEGRAM_USER}&text=${text}&parse_mode=HTML`;
  const req = https.request({
    hostname: 'api.telegram.org', port: 443, path, method: 'GET'
  }, res => { res.on('data', () => {}); });
  req.on('error', e => console.warn('Telegram error:', e.message));
  req.end();
}

let lastScanNotif = 0;


function formatPhone(phone) {
  let n = phone.replace(/[\s.\-+()\[\]]/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('0'))  n = '33' + n.slice(1);
  if (n.length <= 10 && !n.startsWith('33')) n = '33' + n;
  return n + '@c.us';
}

async function sendWAMessage(phone, message) {
  if (!waClient || waStatus !== 'connected') {
    throw new Error('WhatsApp non connecté. Scannez le QR sur http://localhost:' + PORT + '/wa/qr');
  }
  const jid = formatPhone(phone);
  await waClient.sendMessage(jid, message);
  return { success: true, jid };
}

// ── Gemini ──────────────────────────────────────────────────────────
function anthropicToGemini(incoming) {
  const contents = (incoming.messages || []).map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(msg.content)
      ? msg.content.map(c => ({ text: c.text || '' }))
      : [{ text: msg.content || '' }]
  }));
  return { contents, tools:[{ googleSearch:{} }], generationConfig: { maxOutputTokens: Math.min(incoming.max_tokens || 8192, 8192), temperature: 0.3 } };
}
function geminiToAnthropic(r) {
  const cand = (r.candidates||[])[0]||{};
  const parts = (cand.content||{}).parts||[];
  const queries = ((cand.groundingMetadata||{}).webSearchQueries||[]);
  const text = parts.filter(p=>p.text).map(p=>p.text).join('');
  const content = [];
  for (const q of queries) content.push({ type:'tool_use', name:'web_search', input:{query:q} });
  if (text) content.push({ type:'text', text });
  return { id:'gemini-'+Date.now(), type:'message', role:'assistant', content, model:MODEL,
    stop_reason: cand.finishReason==='STOP'?'end_turn':cand.finishReason,
    usage:{ input_tokens:(r.usageMetadata||{}).promptTokenCount||0, output_tokens:(r.usageMetadata||{}).candidatesTokenCount||0 } };
}
function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname:'generativelanguage.googleapis.com', port:443,
      path:`/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, res => {
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(data)});}catch(e){reject(new Error('Parse:'+data.slice(0,200)));} });
    });
    req.on('error',reject);
    req.setTimeout(300000,()=>{req.destroy();reject(new Error('Timeout 300s'));});
    req.write(body); req.end();
  });
}

// ── Helpers ─────────────────────────────────────────────────────────
function jsonResp(res, code, data) {
  res.writeHead(code, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(data));
}
function parseBody(req) {
  return new Promise((resolve,reject) => {
    let body=''; req.on('data',c=>body+=c);
    req.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});
  });
}


function buildRegisterPage(refCode) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Créer mon compte — PushProspect</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'IBM Plex Sans',sans-serif;background:#0D0F14;min-height:100vh;color:#fff;padding:40px 20px}
.bg{position:fixed;inset:0;background:radial-gradient(ellipse 900px 600px at 50% -100px,rgba(28,84,240,0.18) 0%,transparent 70%);pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;max-width:960px;margin:0 auto}
.logo{font-size:22px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:10px}
.logo-dot{width:8px;height:8px;border-radius:50%;background:#1C54F0;box-shadow:0 0 12px rgba(28,84,240,0.6)}
.tagline{text-align:center;font-size:13px;color:rgba(255,255,255,0.35);margin-bottom:28px}
.ref-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(28,84,240,0.12);border:1px solid rgba(28,84,240,0.25);border-radius:6px;padding:6px 14px;font-size:12px;color:rgba(100,140,255,0.9);margin:0 auto 24px;width:fit-content}

.step-indicator{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:32px}
.step{width:32px;height:32px;border-radius:50%;border:2px solid rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:rgba(255,255,255,0.3);transition:all .3s}
.step.active{border-color:#1C54F0;color:#1C54F0;background:rgba(28,84,240,0.1)}
.step.done{background:#1C54F0;border-color:#1C54F0;color:#fff}
.step-line{flex:1;max-width:60px;height:1px;background:rgba(255,255,255,0.08)}
.step-labels{display:flex;justify-content:center;gap:8px;margin-top:-20px;margin-bottom:28px}
.step-lbl{width:32px;text-align:center;font-size:10px;color:rgba(255,255,255,0.25);white-space:nowrap;margin:0 30px}

/* FORM */
.form-card{background:#1A1D24;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:32px;max-width:480px;margin:0 auto}
.form-title{font-size:18px;font-weight:700;margin-bottom:6px;letter-spacing:-0.3px}
.form-sub{font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:24px;line-height:1.6}
.field{margin-bottom:14px}
label{font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.8px;font-weight:600;display:block;margin-bottom:6px}
input{width:100%;padding:11px 14px;border:1px solid rgba(255,255,255,0.08);border-radius:7px;font-size:13.5px;font-family:inherit;background:rgba(255,255,255,0.04);color:#fff;outline:none;transition:all .18s}
input:focus{border-color:rgba(28,84,240,0.6);background:rgba(28,84,240,0.08);box-shadow:0 0 0 3px rgba(28,84,240,0.12)}
input::placeholder{color:rgba(255,255,255,0.2)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}

.btn-next{width:100%;padding:13px;background:#1C54F0;color:#fff;border:none;border-radius:8px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;transition:all .18s;margin-top:8px;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-next:hover{background:#1444D0;box-shadow:0 6px 20px rgba(28,84,240,0.35)}
.btn-next:disabled{opacity:.5;cursor:not-allowed}

.err-box{background:rgba(220,38,38,0.1);color:#EF4444;border:1px solid rgba(220,38,38,0.25);border-radius:7px;padding:10px 14px;font-size:12px;margin-top:12px;display:none}
.ok-box{background:rgba(14,159,110,0.1);color:#10B981;border:1px solid rgba(14,159,110,0.25);border-radius:7px;padding:10px 14px;font-size:12px;margin-top:12px;display:none}
.login-link{text-align:center;font-size:12px;color:rgba(255,255,255,0.3);margin-top:18px}
.login-link a{color:rgba(100,140,255,0.8);text-decoration:none}
.login-link a:hover{text-decoration:underline}

/* PLANS */
.plans-title{text-align:center;font-size:20px;font-weight:700;margin-bottom:6px;letter-spacing:-0.4px}
.plans-sub{text-align:center;font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:28px}
.plans-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
@media(max-width:800px){.plans-grid{grid-template-columns:1fr 1fr}}
@media(max-width:480px){.plans-grid{grid-template-columns:1fr}}

.plan-card{background:#1A1D24;border:2px solid rgba(255,255,255,0.07);border-radius:14px;padding:22px 16px 20px;cursor:pointer;transition:all .2s;position:relative;user-select:none}
.plan-card:hover{border-color:rgba(28,84,240,0.45);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}
.plan-card.active{border-color:#1C54F0;background:rgba(28,84,240,0.12);box-shadow:0 0 0 1px #1C54F0,0 8px 32px rgba(28,84,240,0.2)}
.popular-badge{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:#1C54F0;color:#fff;font-size:10px;font-weight:700;padding:3px 14px;border-radius:20px;white-space:nowrap;letter-spacing:0.5px;box-shadow:0 2px 8px rgba(28,84,240,0.4)}
.plan-check{position:absolute;top:12px;right:12px;width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:10px;transition:all .2s;background:transparent}
.plan-card.active .plan-check{background:#1C54F0;border-color:#1C54F0;color:#fff}
.plan-name{font-size:14px;font-weight:700;color:#fff;margin-bottom:4px}
.plan-price{font-size:30px;font-weight:300;letter-spacing:-1.5px;color:#fff;line-height:1;margin-bottom:3px}
.plan-price sup{font-size:15px;font-weight:500;vertical-align:top;margin-top:6px;display:inline-block}
.plan-price-sub{font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:12px}
.plan-features{list-style:none;font-size:12px;color:rgba(255,255,255,0.5);line-height:2.1}
.plan-features li{display:flex;align-items:center;gap:6px}
.plan-features li::before{content:'✓';color:#1C54F0;font-weight:700;font-size:11px;flex-shrink:0}
.plan-features li.no::before{content:'✗';color:rgba(255,255,255,0.2)}
.plan-features li.no{color:rgba(255,255,255,0.2)}

.agency-card{background:linear-gradient(135deg,rgba(124,58,237,0.12),rgba(28,84,240,0.08));border-color:rgba(124,58,237,0.25);max-width:480px;margin:0 auto 24px}
.agency-card:hover{border-color:rgba(124,58,237,0.55)}
.agency-card.active{border-color:#7C3AED;box-shadow:0 0 0 1px #7C3AED,0 8px 32px rgba(124,58,237,0.2)}
.agency-card.active .plan-check{background:#7C3AED;border-color:#7C3AED}

.plan-cta{width:100%;padding:13px;border:none;border-radius:8px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;transition:all .18s;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:8px}
.plan-cta-free{background:rgba(255,255,255,0.08);color:#fff}
.plan-cta-free:hover{background:rgba(255,255,255,0.13)}
.plan-cta-paid{background:#1C54F0;color:#fff}
.plan-cta-paid:hover{background:#1444D0;box-shadow:0 6px 20px rgba(28,84,240,0.35)}
.plan-cta-wa{background:#128C7E;color:#fff}
.plan-cta-wa:hover{background:#0a7368}
.plan-cta:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
<div class="bg"></div>
<div class="wrap">

  <div class="logo"><div class="logo-dot"></div>PushProspect</div>
  <div class="tagline">CRM de prospection automatisée · Créez votre espace équipe</div>
  ${refCode ? `<div style="text-align:center"><div class="ref-badge">🔗 Invitation partenaire · Code : <strong>${refCode}</strong></div></div>` : ''}

  <!-- INDICATEUR ÉTAPES -->
  <div class="step-indicator">
    <div class="step active" id="s1">1</div>
    <div class="step-line"></div>
    <div class="step" id="s2">2</div>
    <div class="step-line"></div>
    <div class="step" id="s3">3</div>
  </div>

  <!-- ══ ÉTAPE 1 : COMPTE ══ -->
  <div id="step1">
    <div class="form-card">
      <div class="form-title">Créer votre espace</div>
      <div class="form-sub">Quelques secondes pour configurer votre CRM de prospection</div>

      <div class="field"><label>Nom de votre équipe / agence *</label><input id="teamName" placeholder="Agence XYZ" autocomplete="organization"/></div>
      <div class="form-grid">
        <div class="field"><label>Prénom & Nom</label><input id="adminName" placeholder="Jean Dupont" autocomplete="name"/></div>
        <div class="field"><label>Identifiant *</label><input id="adminLogin" placeholder="jean.dupont" autocomplete="username"/></div>
      </div>
      <div class="field"><label>Mot de passe *</label><input id="adminPass" type="password" placeholder="Min. 6 caractères" autocomplete="new-password" onkeydown="if(event.key==='Enter')goToPlans()"/></div>

      <div class="err-box" id="err1"></div>
      <button class="btn-next" onclick="goToPlans()">
        Choisir mon offre →
      </button>
      <div class="login-link">Déjà un compte ? <a href="/">Se connecter</a></div>
    </div>
  </div>

  <!-- ══ ÉTAPE 2 : PLANS ══ -->
  <div id="step2" style="display:none">
    <div class="plans-title">Choisissez votre offre</div>
    <div class="plans-sub">Crédits à vie · Sans abonnement · Rechargez quand vous voulez</div>

    <div class="plans-grid">

      <!-- GRATUIT -->
      <div class="plan-card" id="pc-free" onclick="selectPlan('free')">
        <div class="plan-check" id="chk-free"></div>
        <div class="plan-name">Gratuit</div>
        <div class="plan-price"><sup>€</sup>0</div>
        <div class="plan-price-sub">pour toujours</div>
        <ul class="plan-features">
          <li>15 crédits offerts</li>
          <li>Scanner IA</li>
          <li>CRM complet</li>
          <li>WhatsApp & Email</li>
          <li class="no">Recharge possible</li>
        </ul>
      </div>

      <!-- STARTER -->
      <div class="plan-card" id="pc-starter" onclick="selectPlan('starter')">
        <div class="plan-check" id="chk-starter"></div>
        <div class="plan-name">Starter</div>
        <div class="plan-price"><sup>€</sup>25</div>
        <div class="plan-price-sub">250 crédits · 0,10€/lead</div>
        <ul class="plan-features">
          <li>250 crédits</li>
          <li>Scanner IA</li>
          <li>CRM complet</li>
          <li>WhatsApp & Email</li>
          <li>Recharge possible</li>
        </ul>
      </div>

      <!-- PRO — POPULAIRE -->
      <div class="plan-card" id="pc-pro" onclick="selectPlan('pro')">
        <div class="popular-badge">⚡ POPULAIRE</div>
        <div class="plan-check" id="chk-pro"></div>
        <div class="plan-name">Pro</div>
        <div class="plan-price"><sup>€</sup>50</div>
        <div class="plan-price-sub">500 crédits · 0,10€/lead</div>
        <ul class="plan-features">
          <li>500 crédits</li>
          <li>Scanner IA</li>
          <li>CRM complet</li>
          <li>WhatsApp & Email</li>
          <li>Recharge possible</li>
        </ul>
      </div>

      <!-- BUSINESS -->
      <div class="plan-card" id="pc-business" onclick="selectPlan('business')">
        <div class="plan-check" id="chk-business"></div>
        <div class="plan-name">Business</div>
        <div class="plan-price"><sup>€</sup>150</div>
        <div class="plan-price-sub">1 500 crédits · 0,10€/lead</div>
        <ul class="plan-features">
          <li>1 500 crédits</li>
          <li>Scanner IA</li>
          <li>CRM complet</li>
          <li>WhatsApp & Email</li>
          <li>Recharge possible</li>
        </ul>
      </div>

    </div>

    <!-- AGENCE -->
    <div class="plan-card agency-card" id="pc-agency" onclick="selectPlan('agency')">
      <div class="plan-check" id="chk-agency"></div>
      <div style="display:flex;align-items:center;gap:14px">
        <div style="font-size:28px">🏢</div>
        <div>
          <div class="plan-name" style="font-size:15px">Agence / Entreprise — Leads illimités</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:3px">Volume illimité · Tarif sur mesure · Support prioritaire · Contactez-nous pour un devis</div>
        </div>
      </div>
    </div>

    <div style="max-width:480px;margin:0 auto">
      <div class="err-box" id="err2"></div>
      <button class="btn-next" id="plan-confirm-btn" onclick="confirmPlan()" disabled>
        Confirmer mon choix →
      </button>
      <div style="text-align:center;margin-top:12px">
        <button onclick="backToStep1()" style="background:none;border:none;color:rgba(255,255,255,0.3);font-size:12px;cursor:pointer;font-family:inherit">← Retour</button>
      </div>
    </div>
  </div>

  <!-- ══ ÉTAPE 3 : CONFIRMATION ══ -->
  <div id="step3" style="display:none">
    <div class="form-card" style="text-align:center;max-width:440px">
      <div id="step3-content"></div>
      <div class="err-box" id="err3"></div>
    </div>
  </div>

</div>

<script>
function getFingerprint() {
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '14px Arial';
  ctx.fillText('fp', 2, 2);
  var data = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || '',
    navigator.platform || '',
    canvas.toDataURL().slice(-50)
  ].join('|');
  var hash = 0;
  for (var i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash) + data.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

var PLANS_DATA = {
  free:     { name:"Gratuit",           credits:15,   price:0   },
  starter:  { name:"Starter",           credits:250,  price:25  },
  pro:      { name:"Pro",               credits:500,  price:50  },
  business: { name:"Business",          credits:1500, price:150 },
  agency:   { name:"Agence/Entreprise", credits:0,    price:0   }
};

var selectedPlan = null;
var formData = {};

function goToPlans() {
  var teamName   = (document.getElementById("teamName").value   || "").trim();
  var adminLogin = (document.getElementById("adminLogin").value || "").trim();
  var adminPass  =  document.getElementById("adminPass").value  || "";
  var adminName  = (document.getElementById("adminName").value  || "").trim();
  var err = document.getElementById("err1");
  err.style.display = "none";

  if (!teamName)        { err.textContent = "Le nom de l'equipe est obligatoire."; err.style.display = "block"; return; }
  if (!adminLogin)      { err.textContent = "L'identifiant est obligatoire.";      err.style.display = "block"; return; }
  if (adminPass.length < 6) { err.textContent = "Mot de passe : 6 caracteres minimum."; err.style.display = "block"; return; }

  formData = { teamName: teamName, adminLogin: adminLogin, adminPass: adminPass, adminName: adminName };

  document.getElementById("step1").style.display = "none";
  document.getElementById("step2").style.display = "block";
  document.getElementById("s1").className = "step done";
  document.getElementById("s2").className = "step active";
}

function backToStep1() {
  document.getElementById("step2").style.display = "none";
  document.getElementById("step1").style.display = "block";
  document.getElementById("s1").className = "step active";
  document.getElementById("s2").className = "step";
}

function selectPlan(id) {
  selectedPlan = id;
  ["free","starter","pro","business","agency"].forEach(function(p) {
    var card = document.getElementById("pc-" + p);
    var chk  = document.getElementById("chk-" + p);
    if (card) card.classList.remove("active");
    if (chk)  chk.textContent = "";
  });
  var card = document.getElementById("pc-" + id);
  var chk  = document.getElementById("chk-" + id);
  if (card) card.classList.add("active");
  if (chk)  chk.textContent = "✓";
  document.getElementById("plan-confirm-btn").disabled = false;
  document.getElementById("err2").style.display = "none";
}

function confirmPlan() {
  if (!selectedPlan) return;

  if (selectedPlan === "agency") {
    window.open("https://wa.me/33759536475?text=" + encodeURIComponent("Bonjour, offre Agence PushProspect. Equipe : " + formData.teamName), "_blank");
    return;
  }

  document.getElementById("step2").style.display = "none";
  document.getElementById("step3").style.display = "block";
  document.getElementById("s2").className = "step done";
  document.getElementById("s3").className = "step active";

  var s3 = document.getElementById("step3-content");
  var theRefCode = "` + refCode + `";

  if (selectedPlan === "free") {
    s3.innerHTML = "<div style='font-size:18px;font-weight:700;margin-bottom:8px'>Creation en cours...</div>";
fetch("/teams/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({}, formData, { plan: "free", refCode: theRefCode, fingerprint: getFingerprint() }))    })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (res.status === 429) {
        showErr3("Un compte a déjà été créé depuis votre connexion internet aujourd'hui. Connectez-vous à votre compte existant sur la page d'accueil, ou contactez le support : 07 59 53 64 75");
        return;
      }
      if (!res.ok) { showErr3(res.data.error || "Erreur creation"); return; }
      s3.innerHTML = "<div style='font-size:20px;font-weight:700;margin-bottom:8px;color:#10B981'>Compte cree !</div><div style='font-size:13px;color:rgba(255,255,255,0.5)'>15 credits offerts. Redirection...</div>";
      setTimeout(function() { window.location.href = "/"; }, 2000);
    })
    .catch(function(e) { showErr3("Erreur reseau : " + e.message); });

  } else {
    s3.innerHTML = "<div style='font-size:18px;font-weight:700;margin-bottom:8px'>Redirection paiement...</div>";
    fetch("/teams/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({}, formData, { plan: "pending", refCode: theRefCode, fingerprint: getFingerprint() }))    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (!res.ok) { showErr3(res.data.error || "Erreur creation"); return; }
      return fetch("/stripe/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: selectedPlan, teamId: res.data.teamId, userId: res.data.adminId, refCode: theRefCode })
      });
    })
    .then(function(r) { if (!r) return; return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (!res || !res.ok || !res.data.url) { showErr3((res && res.data.error) || "Erreur Stripe"); return; }
      window.location.href = res.data.url;
    })
    .catch(function(e) { showErr3("Erreur reseau : " + e.message); });
  }
}
function showErr3(msg) {
  document.getElementById("step3-content").innerHTML = "<div style='font-size:40px;margin-bottom:12px'>❌</div><div style='font-size:16px;font-weight:700'>Une erreur est survenue</div>";
  var el = document.getElementById("err3");
  el.textContent = msg;
  el.style.display = "block";
}
</script>
</body>
</html>`;
}


// ── QR Page HTML ────────────────────────────────────────────────────
function qrPageHTML(qr, status) {
  if (status === 'connected') return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WA Connecté</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4}
  .b{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1)}</style></head>
  <body><div class="b"><div style="font-size:56px">✅</div><h2 style="color:#16a34a">WhatsApp Connecté !</h2>
  <p style="color:#555">PushProspect peut envoyer des messages automatiquement.</p>
  <p style="color:#999;font-size:12px">Fermez cette page et retournez sur PushProspect.</p></div></body></html>`;

  if (status === 'qr' && qr) return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Scanner QR WhatsApp</title>
  <meta http-equiv="refresh" content="20">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>*{box-sizing:border-box}body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8f7f4}
  .b{text-align:center;padding:36px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:380px;width:90%}
  #qr{display:inline-block;padding:14px;border:2px solid #e8e5de;border-radius:12px;margin:16px 0}
  .step{font-size:12px;color:#7a7670;text-align:left;line-height:2.2;background:#f8f7f4;border-radius:8px;padding:12px 16px;margin-top:12px}
  .green{color:#25D366;font-weight:600}
  </style></head>

  <body><div class="b">
    <div style="font-size:40px">📱</div>
    <h2 style="margin:8px 0 4px;font-size:18px">Connecter WhatsApp</h2>
    <p style="color:#7a7670;font-size:13px;margin:0 0 8px">Scannez ce QR code avec votre téléphone</p>
    <div id="qr"></div>
    <div class="step">
      1. Ouvrez <span class="green">WhatsApp</span> sur votre téléphone<br>
      2. Allez dans <strong>Paramètres → Appareils connectés</strong><br>
      3. Appuyez sur <strong>"Connecter un appareil"</strong><br>
      4. Scannez le QR code ci-dessus
    </div>
    <p style="font-size:11px;color:#bbb;margin-top:12px">🔄 Page rafraîchie automatiquement · QR valable ~60s</p>
  </div>
  <script>new QRCode(document.getElementById('qr'),{text:${JSON.stringify(qr)},width:220,height:220,colorDark:'#1a1916',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});</script>
  </body></html>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Initialisation WA</title>
  <meta http-equiv="refresh" content="5">
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f7f4}
  @keyframes s{to{transform:rotate(360deg)}}
  .spin{animation:s 1s linear infinite;font-size:40px;display:inline-block}</style></head>
  <body><div style="text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1)">
  <div class="spin">⏳</div><h2 style="margin-top:16px">Initialisation…</h2>
  <p style="color:#7a7670;font-size:13px">Le QR code apparaît dans 20-30 secondes.<br>Cette page se rafraîchit automatiquement.</p>
  </div></body></html>`;
}


function callGroq(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      max_tokens: 1024,
      temperature: 0.5
    });
    const req = https.request({
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse Groq: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout Groq')); });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
//  SERVEUR — TOUTES les routes sont ICI, à l'intérieur du handler
// ══════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  // ── RATE LIMIT /teams/create ──
if (url === '/teams/create' && req.method === 'POST') {
  const rlIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const rlNow = Date.now();
  const rlEntry = global._rateLimitMap.get(rlIp) || [];
  const rlRecent = rlEntry.filter(t => rlNow - t < 60000);
  if (rlRecent.length >= 3) {
    jsonResp(res, 429, { error: 'Trop de tentatives. Attendez quelques minutes.' });
    return;
  }
  global._rateLimitMap.set(rlIp, [...rlRecent, rlNow]);
}

  // ── HTML principal ──
// ── Page inscription publique ──
  if (req.method === 'GET' && url === '/register') {
    const refCode = new URL('http://x' + req.url).searchParams.get('ref') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildRegisterPage(refCode));
    return;
  }

  // ── HTML principal ──
if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(HTML); return;
  }

  // ── Fichiers statiques (logo, images, css…) ──
  const ext = path.extname(url);
  if (req.method === 'GET' && ['.png','.jpg','.jpeg','.gif','.svg','.ico','.webp'].includes(ext)) {
    const f = path.join(__dirname, url);
    if (fs.existsSync(f)) {
      const mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.webp':'image/webp'};
      res.writeHead(200, {'Content-Type': mime[ext]||'application/octet-stream'});
      res.end(fs.readFileSync(f)); return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // ── /health ──
  if (req.method === 'GET' && url === '/health') {
    const counts = {};
    for (const k of Object.keys(DB_FILES)) { try{counts[k]=(readDB(k)||[]).length;}catch(e){counts[k]=0;} }
    jsonResp(res, 200, { ok:true, provider:'Google Gemini', model:MODEL, key:'…'+API_KEY.slice(-6), persistence:'disk',
      whatsapp:{ status:waStatus, connected:waStatus==='connected', user:waClient?.info?.pushname||null }, counts });
    return;
  }

  // ── GMAIL : /gmail/auth ──
  if (req.method === 'GET' && url === '/gmail/auth') {
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
      res.writeHead(500, {'Content-Type':'text/plain'});
      res.end('GMAIL_CLIENT_ID ou GMAIL_CLIENT_SECRET manquant dans .env');
      return;
    }
    const params = new URLSearchParams({
  client_id: GMAIL_CLIENT_ID,
  redirect_uri: GMAIL_REDIRECT_URI,
  response_type: 'code',
  scope: 'https://mail.google.com/',
  access_type: 'offline',
  prompt: 'select_account consent',
  login_hint: 'pro.leadsvision@gmail.com',
});
    res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params });
    res.end(); return;
  }

  // ── GMAIL : /gmail/callback ──
  if (req.method === 'GET' && url.startsWith('/gmail/callback')) {
    const code = new URL('http://x' + req.url).searchParams.get('code');
    if (!code) { res.writeHead(400); res.end('Code manquant'); return; }
    const body = new URLSearchParams({
      code, client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      redirect_uri: GMAIL_REDIRECT_URI, grant_type: 'authorization_code',
    }).toString();
    const tokenReq = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, tokenRes => {
      let d = ''; tokenRes.on('data', c => d += c);
      tokenRes.on('end', () => {
        try {
          const token = JSON.parse(d);
          token.obtained_at = Date.now();
          saveGmailToken(token);
          console.log('  ✅ Gmail connecté — token sauvegardé');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4">
            <div style="text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1)">
            <div style="font-size:56px">✅</div><h2 style="color:#16a34a">Gmail connecté !</h2>
            <p>Fermez cette page et retournez sur PushProspect.</p>
            <script>setTimeout(()=>window.close(),3000)</script>
            </div></body></html>`);
        } catch(e) {
          res.writeHead(500); res.end('Erreur token : ' + e.message);
        }
      });
    });
    tokenReq.on('error', e => { res.writeHead(500); res.end(e.message); });
    tokenReq.write(body); tokenReq.end(); return;
  }

  // ── GMAIL : /gmail/status ──
  if (req.method === 'GET' && url === '/gmail/status') {
    const token = readGmailToken();
    jsonResp(res, 200, { connected: !!token, email: token?.email || null }); return;
  }

  // ── GMAIL : /gmail/send ──
  if (req.method === 'POST' && url === '/gmail/send') {
    try {
      const { to, subject, body: emailBody } = await parseBody(req);
      if (!to || !subject || !emailBody) { jsonResp(res, 400, { error: 'to, subject, body requis' }); return; }

      let token = readGmailToken();
      if (!token) { jsonResp(res, 401, { error: 'Gmail non connecté — connectez-vous via /gmail/auth' }); return; }

      // Rafraîchir le token si expiré
      if (Date.now() > (token.obtained_at + (token.expires_in - 60) * 1000) && token.refresh_token) {
        const refreshBody = new URLSearchParams({
          client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
          refresh_token: token.refresh_token, grant_type: 'refresh_token',
        }).toString();
        token = await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(refreshBody) }
          }, res2 => {
            let d = ''; res2.on('data', c => d += c);
            res2.on('end', () => {
              const t = JSON.parse(d);
              t.obtained_at = Date.now();
              t.refresh_token = token.refresh_token;
              saveGmailToken(t); resolve(t);
            });
          });
          r.on('error', reject); r.write(refreshBody); r.end();
        });
      }

      // Construire l'email RFC 2822 encodé en base64url
const raw = [
  `To: ${to}`,
  `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
  `MIME-Version: 1.0`,
  `Content-Type: text/html; charset=UTF-8`,
  `Content-Transfer-Encoding: base64`,
  ``,
  Buffer.from(`<html><body>${emailBody}</body></html>`, 'utf8').toString('base64')
].join('\r\n');
      const encoded = Buffer.from(raw).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const gmailPayload = JSON.stringify({ raw: encoded });
      await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'gmail.googleapis.com',
          path: '/gmail/v1/users/me/messages/send',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token.access_token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(gmailPayload)
          }
        }, res2 => {
          let d = ''; res2.on('data', c => d += c);
          res2.on('end', () => {
            const result = JSON.parse(d);
            if (result.error) reject(new Error(result.error.message));
            else resolve(result);
          });
        });
        r.on('error', reject); r.write(gmailPayload); r.end();
      });

      console.log(`  ✉️  Gmail → ${to} | ${subject}`);
      jsonResp(res, 200, { ok: true });
    } catch(err) {
      console.error('  ✗ Gmail send:', err.message);
      jsonResp(res, 500, { error: err.message });
    }
    return;
  }

  // ── WhatsApp : /wa/qr ──
  if (req.method === 'GET' && url === '/wa/qr') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(qrPageHTML(waQR, waStatus)); return;
  }

  // ── WhatsApp : /wa/status ──
  if (req.method === 'GET' && url === '/wa/status') {
    jsonResp(res, 200, { status:waStatus, connected:waStatus==='connected', hasQR:!!waQR, user:waClient?.info?.pushname||null });
    return;
  }

  // ── WhatsApp : /wa/disconnect ──
  if (req.method === 'POST' && url === '/wa/disconnect') {
    try { if (waClient) await waClient.destroy().catch(()=>{}); } catch(e) {}
    waClient = null; waStatus = 'disconnected'; waQR = null;
    try { fs.rmSync(WA_DIR,{recursive:true,force:true}); fs.mkdirSync(WA_DIR,{recursive:true}); } catch(e) {}
    jsonResp(res, 200, { ok:true }); return;
  }

  // ── WhatsApp : /wa/send ──
  if (req.method === 'POST' && url === '/wa/send') {
    try {
      const { phone, message, contactId, contactName, situation, templateId, niche, ville } = await parseBody(req);
      if (!phone || !message) { jsonResp(res, 400, { error:'phone et message requis' }); return; }
      const result = await sendWAMessage(phone, message);
      const msgs = readDB('messages') || [];
      msgs.unshift({
        id: Date.now() + Math.random(), contactId, contactName, phone,
        niche: niche||'', ville: ville||'', situation: situation||'manuel',
        templateId: templateId||null, message,
        sentAt: new Date().toISOString(),
        sentDate: new Date().toISOString().split('T')[0],
        user: 'auto', method: 'whatsapp-web'
      });
      writeDB('messages', msgs.slice(0, 500));
      console.log(`  📱 WA envoyé → ${phone} (${contactName||'?'}) [${situation||'?'}]`);
      jsonResp(res, 200, { ok:true, jid:result.jid });
    } catch(err) {
      console.error('  ✗ WA send:', err.message);
      jsonResp(res, 500, { error: err.message });
    }
    return;
  }

  // ── Proxy Gemini : /api ──
  // ── Teams : /teams/create ──
if (req.method === 'POST' && url === '/teams/create') {
  try {
    const { teamName, adminLogin, adminPass, adminName, expiresAt, plan, refCode, fingerprint } = await parseBody(req);
    console.log('🛡️ CREATE TEAM tentative:', {
  teamName, adminLogin,
  fingerprint: fingerprint || 'ABSENT',
  plan: plan || 'free'
});
    if (!teamName || !adminLogin || !adminPass) {
      jsonResp(res, 400, { error: 'teamName, adminLogin, adminPass requis' }); return;
    }

    // ── ANTI-ABUS : 1 compte gratuit max par IP par 24h ──
// Remplace tout le bloc ── ANTI-ABUS ── dans /teams/create par ceci :

const clientIp = (req.headers['x-forwarded-for']||'').split(',')[0].trim()

  || req.headers['x-real-ip']
  || req.socket.remoteAddress
  || 'unknown';

const planKey = plan || 'free';
console.log('🌐 IP détectée:', clientIp, '| FP:', fingerprint || 'ABSENT');


if (planKey !== 'superadmin') {
  const IP_FILE = path.join(DATA_DIR, 'ip_registry.json');
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  let ipRegistry = {};
  try {
    if (fs.existsSync(IP_FILE)) {
      ipRegistry = JSON.parse(fs.readFileSync(IP_FILE, 'utf8'));
    }
  } catch(e) { ipRegistry = {}; }

  // Nettoyer les entrées expirées
  for (const ip of Object.keys(ipRegistry)) {
    if (Array.isArray(ipRegistry[ip])) {
      ipRegistry[ip] = ipRegistry[ip].filter(t => now - t < WINDOW_MS);
      if (!ipRegistry[ip].length) delete ipRegistry[ip];
    }
  }

  const fp = fingerprint || '';

  // Clés de détection multicouches
  const keysToCheck = [
    clientIp !== 'unknown' && clientIp !== '::1' && clientIp !== '127.0.0.1' ? clientIp : null,
    fp ? 'fp_' + fp : null,
  ].filter(Boolean);

  // Extraire le /24 du subnet pour détecter partage de connexion
  const ipv4Match = clientIp.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (ipv4Match) {
    keysToCheck.push('subnet_' + ipv4Match[1]);
  }

  // Vérifier si l'une des clés est déjà bloquée
  for (const key of keysToCheck) {
    const attempts = ipRegistry[key] || [];
    // Subnet plus permissif : 3 comptes max par /24
    const limit = key.startsWith('subnet_') ? 3 : 1;
    if (attempts.length >= limit) {
      jsonResp(res, 429, {
        error: 'Un compte a déjà été créé depuis cet appareil ou réseau aujourd\'hui. Connectez-vous à votre compte existant ou contactez le support au 07 59 53 64 75.'
      });
      return;
    }
  }

  // Vérifier aussi le nom d'équipe similaire dans les 24h
  const teams = readDB('teams');
  const recentFromSameNetwork = teams.filter(t => {
    const tKey = 'team_ip_' + t.id;
    return ipRegistry[tKey] && ipRegistry[tKey].some(entry => {
      if (typeof entry === 'object') {
        return (keysToCheck.includes(entry.ip) || keysToCheck.includes('fp_' + entry.fp)) && (now - entry.ts < WINDOW_MS);
      }
      return false;
    });
  });
  if (recentFromSameNetwork.length >= 2) {
    jsonResp(res, 429, {
      error: 'Trop de comptes créés depuis ce réseau. Contactez le support au 07 59 53 64 75.'
    });
    return;
  }

  // Enregistrer toutes les clés
  for (const key of keysToCheck) {
    const attempts = ipRegistry[key] || [];
    ipRegistry[key] = [...attempts, now];
  }

  // Enregistrer le login
  const loginKey = 'login_' + adminLogin.toLowerCase();
  ipRegistry[loginKey] = [now];

  // Enregistrer IP+FP liés à cette équipe (pour détection réseau)
  const teamTrackKey = 'team_ip_team_' + Date.now();
  ipRegistry[teamTrackKey] = [{ ip: clientIp, fp, ts: now }];

  try {
    fs.writeFileSync(IP_FILE, JSON.stringify(ipRegistry, null, 2), 'utf8');
  } catch(e) {
    console.error('Erreur écriture ip_registry:', e.message);
  }
}
    // ── FIN ANTI-ABUS ──

const users = readDB('users');
if (users.find(u => u.login === adminLogin)) {
  jsonResp(res, 400, { error: 'Identifiant déjà utilisé' }); return;
}
const teams = readDB('teams');
const recentTeam = teams.find(t =>
  t.name && t.name.toLowerCase() === teamName.toLowerCase() &&
  t.createdAt >= new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0]
);
if (recentTeam) {
  jsonResp(res, 400, { error: 'Une équipe avec ce nom a déjà été créée aujourd\'hui.' });
  return;
}
const teamId = 'team_' + Date.now();
const adminId = 'user_' + Date.now() + '_admin';


    teams.push({
      id: teamId, name: teamName, ownerId: adminId,
      createdAt: new Date().toISOString().split('T')[0],
      subscription: { status: 'active', expiresAt: expiresAt || null, plan: 'starter' }
    });
    users.push({
      id: adminId, login: adminLogin, name: adminName || adminLogin,
      pass: adminPass, role: 'admin', teamId,
      refCode: refCode || null,
      created: new Date().toISOString().split('T')[0]
    });
    writeDB('teams', teams);
    writeDB('users', users);
    if (refCode) {
      const affiliates = readDB('affiliates') || [];
      const aff = affiliates.find(a => a.code === refCode);
      if (aff) {
        if (!aff.referredTeams) aff.referredTeams = [];
        aff.referredTeams.push({ teamId, teamName, adminLogin, joinedAt: new Date().toISOString() });
        writeDB('affiliates', affiliates);
        console.log(`🔗 Filleul enregistré : ${teamName} (ref: ${refCode})`);
      }
    }
    const planDef = PLANS[planKey] || PLANS.free;
    addCredits(teamId, planDef.credits, `Inscription — plan ${planDef.name}`, planKey);
    console.log(`  ✅ Équipe créée : ${teamName} (admin: ${adminLogin}) — plan: ${planKey} (${planDef.credits} crédits) — IP: ${clientIp}`);
    sendTelegram(`🆕 <b>Nouvelle inscription</b>\n🏢 ${teamName}\n👤 ${adminLogin}\n📦 Plan : ${planDef.name}\n🔗 Ref : ${refCode || 'aucune'}${refCode ? ' ✅' : ''}\n🌐 IP : ${clientIp}\n🕐 ${new Date().toLocaleString('fr-FR')}`);
    jsonResp(res, 200, { ok: true, teamId, adminId });
  } catch(err) {
    jsonResp(res, 500, { error: err.message });
  }
  return;
}

  // ── Teams : GET /teams ──
  if (req.method === 'GET' && url === '/teams') {
    const teams = readDB('teams');
    const users = readDB('users');
    const result = teams.map(t => ({
      ...t,
      memberCount: users.filter(u => u.teamId === t.id).length,
      members: users.filter(u => u.teamId === t.id).map(u => ({
        id: u.id, login: u.login, name: u.name, role: u.role
      }))
    }));
    jsonResp(res, 200, { data: result }); return;
  }

  // ── Proxy Gemini : /api ──
// ── Crédits : status ──
  if (req.method === 'GET' && url.startsWith('/credits/status')) {
    try {
      const teamId = new URL('http://x' + req.url).searchParams.get('teamId');
      if (!teamId) { jsonResp(res, 400, { error: 'teamId requis' }); return; }
      const entry = getTeamCredits(teamId);
      jsonResp(res, 200, { ok: true, credits: entry || { balance: 0, plan: 'free', totalBought: 0 } });
    } catch(err) { jsonResp(res, 500, { error: err.message }); }
    return;
  }

  // ── Crédits : consommer ──
  if (req.method === 'POST' && url === '/credits/consume') {
    try {
      const { teamId, count } = await parseBody(req);
      if (!teamId) { jsonResp(res, 400, { error: 'teamId requis' }); return; }
      const result = consumeCredit(teamId, count || 1);
      jsonResp(res, result.ok ? 200 : 402, result);
    } catch(err) { jsonResp(res, 500, { error: err.message }); }
    return;
  }

  // ── Crédits : recharger manuellement (superadmin) ──
  if (req.method === 'POST' && url === '/credits/add') {
    try {
      const { teamId, amount, reason, plan } = await parseBody(req);
      if (!teamId || !amount) { jsonResp(res, 400, { error: 'teamId et amount requis' }); return; }
      const entry = addCredits(teamId, amount, reason || 'Ajout manuel', plan);
      jsonResp(res, 200, { ok: true, credits: entry });
    } catch(err) { jsonResp(res, 500, { error: err.message }); }
    return;
  }

  // ── Proxy Gemini : /api ──
  if (req.method === 'POST' && url === '/api') {
    try {
      const incoming = await parseBody(req);
      const { status, body: gR } = await callGemini(anthropicToGemini(incoming));
      if (status !== 200) {
        const msg = (gR.error||{}).message || JSON.stringify(gR).slice(0,200);
        jsonResp(res, status, { error:{ type:'api_error', message:`Gemini ${status}: ${msg}` } }); return;
      }
      const out = geminiToAnthropic(gR);
const searchCount = out.content.filter(b=>b.type==='tool_use').length;
console.log(`  ✓ /api — ${searchCount} recherche(s) · ${new Date().toLocaleTimeString()}`);
const now = Date.now();
if(now - lastScanNotif > 60000) {
  lastScanNotif = now;
  sendTelegram(`🔍 <b>Scanner IA lancé</b>\n🕐 ${new Date().toLocaleString('fr-FR')}`);
}
jsonResp(res, 200, out);
    } catch(err) {
      console.error('  ✗ /api:', err.message);
      jsonResp(res, 500, { error:{ message:err.message } });
    }
    return;
  }

  // ── Persistance : /db/:key ──
  const dbMatch = url.match(/^\/db\/(\w+)$/);
  if (dbMatch) {
    const key = dbMatch[1];
    if (!DB_FILES[key]) { jsonResp(res, 404, { error:'Unknown key' }); return; }
    if (req.method === 'GET') { jsonResp(res, 200, { data:readDB(key) }); return; }
if (req.method === 'POST') {
  try {
    const b = await parseBody(req);
    const ok = writeDB(key, b.data);
    jsonResp(res, ok ? 200 : 500, { ok });
  }
      catch(e) { jsonResp(res, 400, { error:e.message }); }
      return;
    }
  }

// ══ CHAT SUPPORT ══
  if (req.method === 'POST' && url === '/chat') {
    try {
      const { messages } = await parseBody(req);
      if (!messages || !messages.length) {
        jsonResp(res, 400, { error: 'messages requis' }); return;
      }
      const systemPrompt = {
        role: 'system',
        content: `Tu es l'assistant support de PushProspect, un CRM de prospection automatisée.
Tu aides les utilisateurs avec : la connexion/compte, le scanner de prospects, l'agenda, le pipeline, WhatsApp, les emails, les rendez-vous, et la facturation.
Réponds toujours en français, de façon concise et professionnelle.
Si l'utilisateur a un problème urgent ou technique grave, dis-lui de contacter directement Alexis au 07 59 53 64 75.
Ne réponds qu'aux questions liées à PushProspect.`
      };
const result = await callGroq([systemPrompt, ...messages]);
      console.log('GROQ RESULT:', JSON.stringify(result).slice(0, 500)); // ← log temporaire
      const reply = result.choices?.[0]?.message?.content || 'Désolé, je n\'ai pas pu générer une réponse.';
      jsonResp(res, 200, { reply });

    } catch(err) {
      console.error('  ✗ /chat:', err.message);
      jsonResp(res, 500, { error: err.message });
    }
    return;
  }

  // ── AFFILIATION : générer/récupérer le lien d'un utilisateur ──
if (req.method === 'POST' && url === '/affiliate/init') {
  try {
    const { userId } = await parseBody(req);
    const affiliates = readDB('affiliates') || [];
    let aff = affiliates.find(a => a.userId === userId);
    if (!aff) {
      const code = 'REF' + Math.random().toString(36).substr(2, 8).toUpperCase();
      aff = {
        userId,
        code,
        createdAt: new Date().toISOString(),
        balance: 0,
        totalEarned: 0,
        lastPayoutRequest: null
      };
      affiliates.push(aff);
      writeDB('affiliates', affiliates);
    }
    jsonResp(res, 200, { ok: true, affiliate: aff });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
  return;
}

// ── AFFILIATION : récupérer les stats d'un affilié ──
if (req.method === 'GET' && url.startsWith('/affiliate/stats')) {
  try {
    const userId = new URL('http://x' + req.url).searchParams.get('userId');
    const affiliates = readDB('affiliates') || [];
    const deposits = readDB('deposits') || [];
    const users = readDB('users') || [];
    const aff = affiliates.find(a => a.userId === userId);
    if (!aff) { jsonResp(res, 404, { error: 'Non trouvé' }); return; }
    // Toutes les équipes créées via ce code
    const referred = users.filter(u => u.refCode === aff.code);
    // Tous les dépôts liés à ces utilisateurs
    const refDeposits = deposits.filter(d => referred.some(u => u.id === d.userId || u.teamId === d.teamId));
    const totalDeposits = refDeposits.reduce((s, d) => s + (d.amount || 0), 0);
    const commission = Math.round(totalDeposits * 0.20 * 100) / 100;
    jsonResp(res, 200, {
      affiliate: aff,
      referred: referred.map(u => ({
        id: u.id, name: u.name || u.login, login: u.login,
        teamId: u.teamId, createdAt: u.created,
        deposits: deposits.filter(d => d.userId === u.id || d.teamId === u.teamId)
                          .reduce((s, d) => s + (d.amount || 0), 0)
      })),
      totalDeposits,
      commission,
      balance: aff.balance || 0,
      totalEarned: aff.totalEarned || 0,
      lastPayoutRequest: aff.lastPayoutRequest || null,
      history: refDeposits
    });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
  return;
}



// ── AFFILIATION : création de compte via lien affilié ──
if (req.method === 'POST' && url === '/affiliate/register') {
  try {
    const { teamName, adminLogin, adminPass, adminName, refCode } = await parseBody(req);
    if (!teamName || !adminLogin || !adminPass) {
      jsonResp(res, 400, { error: 'Champs requis manquants' }); return;
    }
const users = readDB('users');
if (users.find(u => u.login === adminLogin)) {
  jsonResp(res, 400, { error: 'Identifiant déjà utilisé' }); return;
}
const teams = readDB('teams');
const recentTeam = teams.find(t =>
  t.name && t.name.toLowerCase() === teamName.toLowerCase() &&
  t.createdAt >= new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0]
);
if (recentTeam) {
  jsonResp(res, 400, { error: 'Une équipe avec ce nom a déjà été créée aujourd\'hui.' });
  return;
}
const teamId = 'team_' + Date.now();
const adminId = 'user_' + Date.now() + '_admin';
    teams.push({
      id: teamId, name: teamName, ownerId: adminId,
      createdAt: new Date().toISOString().split('T')[0],
      subscription: { status: 'active', expiresAt: null, plan: 'starter' }
    });
    users.push({
      id: adminId, login: adminLogin, name: adminName || adminLogin,
      pass: adminPass, role: 'admin', teamId,
      refCode: refCode || null,
      created: new Date().toISOString().split('T')[0]
    });
    writeDB('teams', teams);
    writeDB('users', users);

    // Mettre à jour le solde de l'affilié si refCode valide
    if (refCode) {
      const affiliates = readDB('affiliates') || [];
      const aff = affiliates.find(a => a.code === refCode);
      if (aff) {
        if (!aff.referredTeams) aff.referredTeams = [];
        aff.referredTeams.push({ teamId, teamName, adminLogin, joinedAt: new Date().toISOString() });
        writeDB('affiliates', affiliates);
      }
    }
    console.log(`✅ Inscription affiliée : ${teamName} (ref: ${refCode || 'aucun'})`);
    jsonResp(res, 200, { ok: true, teamId, adminId });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
  return;
}

// ── AFFILIATION : enregistrer un dépôt (appelé par Stripe webhook ou manuellement) ──
if (req.method === 'POST' && url === '/affiliate/deposit') {
  try {
    const { userId, teamId, amount, description } = await parseBody(req);
    if (!amount || amount <= 0) { jsonResp(res, 400, { error: 'Montant invalide' }); return; }
    const deposits = readDB('deposits') || [];
    const deposit = {
      id: 'dep_' + Date.now(),
      userId, teamId, amount,
      description: description || 'Rechargement crédits',
      createdAt: new Date().toISOString()
    };
    deposits.push(deposit);
    writeDB('deposits', deposits);

    // Calculer et créditer la commission chez l'affilié
    const users = readDB('users') || [];
    const user = users.find(u => u.id === userId || u.teamId === teamId);
    if (user && user.refCode) {
      const affiliates = readDB('affiliates') || [];
      const aff = affiliates.find(a => a.code === user.refCode);
      if (aff) {
        const commission = Math.round(amount * 0.20 * 100) / 100;
        aff.balance = Math.round(((aff.balance || 0) + commission) * 100) / 100;
        aff.totalEarned = Math.round(((aff.totalEarned || 0) + commission) * 100) / 100;
        if (!aff.commissionHistory) aff.commissionHistory = [];
        aff.commissionHistory.push({
          depositId: deposit.id, amount, commission,
          from: user.name || user.login, createdAt: deposit.createdAt
        });
        writeDB('affiliates', affiliates);
console.log(`💸 Commission +${commission}€ pour affilié ${aff.userId}`);
sendTelegram(`💸 <b>Commission d'affiliation</b>\n👤 Filleul : ${user.name || user.login}\n💰 Dépôt : ${amount}€\n📈 Commission : +${commission}€\n🕐 ${new Date().toLocaleString('fr-FR')}`);
      }
    }
    jsonResp(res, 200, { ok: true, deposit });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
  return;
}

// ── AFFILIATION : demande de payout ──
if (req.method === 'POST' && url === '/affiliate/payout-request') {
  try {
    const { userId } = await parseBody(req);
    const affiliates = readDB('affiliates') || [];
    const aff = affiliates.find(a => a.userId === userId);
    if (!aff) { jsonResp(res, 404, { error: 'Affilié introuvable' }); return; }
    if ((aff.balance || 0) < 20) {
      jsonResp(res, 400, { error: 'Solde insuffisant (minimum 20€)' }); return;
    }
    const now = new Date();
    if (aff.lastPayoutRequest) {
      const last = new Date(aff.lastPayoutRequest);
      const diffDays = (now - last) / (1000 * 60 * 60 * 24);
      if (diffDays < 15) {
        jsonResp(res, 400, { error: `Prochain payout possible dans ${Math.ceil(15 - diffDays)} jours` }); return;
      }
    }
    aff.lastPayoutRequest = now.toISOString();
    const payouts = readDB('payouts') || [];
    payouts.push({
      id: 'pay_' + Date.now(), userId, amount: aff.balance,
      status: 'pending', requestedAt: now.toISOString()
    });
    writeDB('payouts', payouts);
    writeDB('affiliates', affiliates);
    jsonResp(res, 200, { ok: true, amount: aff.balance });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
  return;
}

// ── AFFILIATION : reset solde (superadmin) ──
if (req.method === 'POST' && url === '/affiliate/reset-balance') {
  try {
    const { userId } = await parseBody(req);
    const affiliates = readDB('affiliates') || [];
    const aff = affiliates.find(a => a.userId === userId);
    if (!aff) { jsonResp(res, 404, { error: 'Affilié introuvable' }); return; }
    const paidAmount = aff.balance;
    aff.balance = 0;
    if (!aff.paidHistory) aff.paidHistory = [];
    aff.paidHistory.push({ amount: paidAmount, paidAt: new Date().toISOString() });
    writeDB('affiliates', affiliates);
    jsonResp(res, 200, { ok: true });
  } catch(err) { jsonResp(res, 500, { error: err.message }); }
  return;
}

// ── STRIPE : rechargement de crédits ──
// ── STRIPE : créer session paiement ──
if (req.method === 'POST' && url === '/stripe/create-session') {
    try {
      const { planId, teamId, userId, refCode, amount, credits } = await parseBody(req);

      let productName, unitAmount, successUrl, cancelUrl;

      if (amount && !planId) {
        // Recharge libre depuis la modal ou l'onglet affiliation
        if (amount < 10) { jsonResp(res, 400, { error: 'Montant minimum : 10€' }); return; }
        const creditsCount = credits || Math.round((amount / 10) * 100);
        productName = `PushProspect — ${creditsCount} crédits`;
        unitAmount = Math.round(amount * 100);
        successUrl = `http://localhost:${PORT}/?payment=success&amount=${amount}&credits=${creditsCount}&teamId=${teamId || ''}&userId=${userId || ''}`;
        cancelUrl  = `http://localhost:${PORT}/`;
      } else {
        // Plan fixe depuis l'inscription
        const plan = PLANS[planId];
        if (!plan || plan.price === 0) { jsonResp(res, 400, { error: 'Plan invalide ou gratuit' }); return; }
        productName = `PushProspect — ${plan.name} (${plan.credits} crédits)`;
        unitAmount  = plan.price * 100;
        successUrl  = `http://localhost:${PORT}/?payment=success&planId=${planId}&teamId=${teamId || ''}&userId=${userId || ''}&refCode=${refCode || ''}`;
        cancelUrl   = `http://localhost:${PORT}/register${refCode ? '?ref=' + refCode : ''}`;
      }

      const bodyStr = new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][product_data][name]': productName,
        'line_items[0][price_data][unit_amount]': String(unitAmount),
        'line_items[0][quantity]': '1',
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        'metadata[teamId]': teamId || '',
        'metadata[userId]': userId || '',
      }).toString();

      const stripeResp = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'api.stripe.com', path: '/v1/checkout/sessions', method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(bodyStr)
          }
        }, res2 => {
          let d = ''; res2.on('data', c => d += c);
          res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        r.on('error', reject); r.write(bodyStr); r.end();
      });

      if (stripeResp.error) { jsonResp(res, 400, { error: stripeResp.error.message }); return; }
      jsonResp(res, 200, { url: stripeResp.url });
    } catch(err) { jsonResp(res, 500, { error: err.message }); }
    return;
  }

  // ── STRIPE : succès paiement (retour URL) ──
if (req.method === 'POST' && url === '/stripe/confirm') {
    try {
      const { planId, teamId, userId, amount, credits } = await parseBody(req);

      let creditCount, planLabel;

      if (amount && !planId) {
        // Recharge libre
        creditCount = credits || Math.round((parseFloat(amount) / 10) * 100);
        planLabel   = `Recharge ${amount}€`;
      } else {
        // Plan fixe
        const plan = PLANS[planId];
        if (!plan) { jsonResp(res, 400, { error: 'Plan invalide' }); return; }
        creditCount = plan.credits;
        planLabel   = `Achat plan ${plan.name}`;
      }

const entry = addCredits(teamId, creditCount, planLabel, planId || 'recharge');
const teams = readDB('teams');
const team = teams.find(t => t.id === teamId);
if (team && planId) { team.plan = planId; writeDB('teams', teams); }

// ── COMMISSION AFFILIÉ ──
const allUsers = readDB('users') || [];
const payingUser = allUsers.find(u => u.id === userId || u.teamId === teamId);
if (payingUser && payingUser.refCode) {
  const affiliates = readDB('affiliates') || [];
  const aff = affiliates.find(a => a.code === payingUser.refCode);
  if (aff) {
    const realAmount = amount ? parseFloat(amount) : (PLANS[planId]?.price || 0);
    const commission = Math.round(realAmount * 0.20 * 100) / 100;
    aff.balance = Math.round(((aff.balance || 0) + commission) * 100) / 100;
    aff.totalEarned = Math.round(((aff.totalEarned || 0) + commission) * 100) / 100;
    if (!aff.commissionHistory) aff.commissionHistory = [];
    aff.commissionHistory.push({
      depositId: 'stripe_' + Date.now(),
      amount: realAmount,
      commission,
      from: payingUser.name || payingUser.login,
      createdAt: new Date().toISOString()
    });
    writeDB('affiliates', affiliates);
    // Enregistrer aussi dans deposits
    const deposits = readDB('deposits') || [];
    deposits.push({
      id: 'dep_' + Date.now(), userId, teamId,
      amount: realAmount,
      description: planLabel,
      createdAt: new Date().toISOString()
    });
    writeDB('deposits', deposits);
    console.log(`💸 Commission +${commission}€ pour affilié ${aff.userId} (filleul: ${payingUser.login})`);
    sendTelegram(`💸 <b>Commission affilié</b>\n👤 Filleul : ${payingUser.name || payingUser.login}\n💰 Dépôt : ${realAmount}€\n📈 Commission : +${commission}€`);
  }
}

console.log(`  💳 Paiement confirmé — ${planLabel} (${creditCount} crédits) pour team ${teamId}`);
sendTelegram(`💳 <b>Paiement reçu</b>\n📦 ${planLabel}\n⚡ ${creditCount} crédits\n🏢 Team : ${teamId}\n🕐 ${new Date().toLocaleString('fr-FR')}`);
jsonResp(res, 200, { ok: true, credits: entry });
    } catch(err) { jsonResp(res, 500, { error: err.message }); }
    return;
  }

  res.writeHead(404); res.end('Not found');  // ← cette ligne existait déjà
});

server.timeout = 300000;

server.listen(PORT, async () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║   PushProspect — Gemini + Persistance + WhatsApp Auto   ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  👉  App     : http://localhost:' + PORT);
  console.log('  📱  QR WA   : http://localhost:' + PORT + '/wa/qr');
  console.log('  ✉️   Gmail   : http://localhost:' + PORT + '/gmail/auth');
  console.log('  🔑  Gemini  : …' + API_KEY.slice(-8));
  console.log('  💾  Data    : ' + DATA_DIR);
  console.log('  📁  Session : ' + WA_DIR);
  console.log('');
  //await initWhatsApp();
});

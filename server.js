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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
<title>PushProspect — Créer un compte</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
html,body{height:100%;font-family:'IBM Plex Sans','Inter',sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
/* LAYOUT */
.page{display:grid;grid-template-columns:1fr 1fr;min-height:100vh;background:#0D0F14}
@media(max-width:768px){.page{grid-template-columns:1fr}}

/* PANNEAU GAUCHE */
.left{background:#0D0F14;padding:48px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.left::before{content:'';position:absolute;top:-200px;left:-200px;width:600px;height:600px;background:radial-gradient(circle,rgba(28,84,240,0.14) 0%,transparent 70%);pointer-events:none}
.left::after{content:'';position:absolute;bottom:-150px;right:-100px;width:400px;height:400px;background:radial-gradient(circle,rgba(28,84,240,0.06) 0%,transparent 70%);pointer-events:none}
@media(max-width:768px){.left{padding:32px 24px;display:none}}

.logo{display:flex;align-items:center;gap:10px;margin-bottom:64px}
.logo-icon{width:36px;height:36px;background:#0D0F14;box-shadow:4px 4px 10px rgba(0,0,0,0.7),-3px -3px 8px rgba(255,255,255,0.03),inset 0 0 0 1px rgba(28,84,240,0.25);border-radius:10px;display:flex;align-items:center;justify-content:center}
.logo-icon svg{width:18px;height:18px}
.logo-name{font-size:18px;font-weight:700;letter-spacing:-0.5px}

.left-content{flex:1;display:flex;flex-direction:column;justify-content:center}
.left-headline{font-size:40px;font-weight:700;letter-spacing:-1.5px;line-height:1.15;margin-bottom:16px}
.left-headline span{background:linear-gradient(135deg,#1C54F0,#7BA4FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.left-sub{font-size:16px;color:rgba(255,255,255,0.45);line-height:1.7;margin-bottom:48px;max-width:380px}

.features{display:flex;flex-direction:column;gap:16px}
.feature{display:flex;align-items:flex-start;gap:14px}
.feature-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
.feature-title{font-size:14px;font-weight:600;margin-bottom:2px}
.feature-desc{font-size:13px;color:rgba(255,255,255,0.4);line-height:1.5}

.left-footer{font-size:12px;color:rgba(255,255,255,0.2);margin-top:48px}

/* PANNEAU DROIT */
.right{background:#0D0F14;display:flex;align-items:center;justify-content:center;padding:48px 40px;position:relative;border-left:1px solid rgba(255,255,255,0.04)}
@media(max-width:768px){.right{padding:32px 20px;min-height:100vh;align-items:flex-start;padding-top:40px}}

.form-container{width:100%;max-width:420px}

.mobile-logo{display:none;align-items:center;gap:10px;margin-bottom:40px}
@media(max-width:768px){.mobile-logo{display:flex}}
.mobile-logo-icon{width:32px;height:32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:8px;display:flex;align-items:center;justify-content:center}
.mobile-logo-name{font-size:16px;font-weight:700}

/* STEPS */
.steps-header{margin-bottom:32px}
.step-label{font-size:12px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:1.5px;font-weight:600;margin-bottom:8px}
.step-title{font-size:24px;font-weight:700;letter-spacing:-0.5px;margin-bottom:6px}
.step-sub{font-size:14px;color:rgba(255,255,255,0.4);line-height:1.6}

.progress-bar{display:flex;gap:4px;margin-bottom:32px}
.progress-seg{height:3px;flex:1;border-radius:2px;background:rgba(255,255,255,0.08);transition:background .3s}
.progress-seg.active{background:#1C54F0}
.progress-seg.done{background:rgba(28,84,240,0.4)}

/* FORM */
.field{margin-bottom:16px}
.field-label{font-size:12px;font-weight:500;color:rgba(255,255,255,0.5);margin-bottom:6px;display:block;letter-spacing:0.3px}
.field-input{width:100%;padding:12px 14px;background:#131620;border:none;border-radius:12px;font-size:13.5px;font-family:'IBM Plex Sans','Inter',sans-serif;color:#fff;outline:none;transition:all .2s;box-shadow:inset 3px 3px 8px rgba(0,0,0,0.6),inset -2px -2px 5px rgba(255,255,255,0.04);caret-color:#1C54F0}
.field-input:focus{background:#131620;box-shadow:inset 3px 3px 8px rgba(0,0,0,0.6),inset -2px -2px 5px rgba(255,255,255,0.04),0 0 0 2px rgba(28,84,240,0.4)}
.field-input::placeholder{color:rgba(255,255,255,0.2)}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}

/* PLANS */
.plans{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.plan{border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px 14px;cursor:pointer;transition:all .2s;position:relative;background:#12151f;box-shadow:4px 4px 10px rgba(0,0,0,0.4),-2px -2px 6px rgba(255,255,255,0.02)}
.plan:hover{border-color:rgba(28,84,240,0.3);background:#131620}
.plan.selected{border-color:#1C54F0;background:rgba(28,84,240,0.1);box-shadow:0 0 0 1px rgba(28,84,240,0.4),4px 4px 10px rgba(0,0,0,0.4)}
.plan-badge{position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:700;padding:2px 10px;border-radius:20px;white-space:nowrap;letter-spacing:0.5px;background:#1C54F0;color:#fff}
.plan-name{font-size:13px;font-weight:600;margin-bottom:4px}
.plan-price{font-size:22px;font-weight:300;letter-spacing:-0.8px;line-height:1;margin-bottom:2px}
.plan-credits{font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:8px}
.plan-check{width:18px;height:18px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;font-size:9px;position:absolute;top:12px;right:12px;transition:all .2s}
.plan.selected .plan-check{background:#6366f1;border-color:#6366f1;color:#fff}

.plan-agency{border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px 16px;cursor:pointer;transition:all .2s;background:#12151f;display:flex;align-items:center;gap:12px;margin-bottom:16px;box-shadow:4px 4px 10px rgba(0,0,0,0.4),-2px -2px 6px rgba(255,255,255,0.02)}
.plan-agency:hover{border-color:rgba(28,84,240,0.3)}
.plan-agency.selected{border-color:#1C54F0;background:rgba(28,84,240,0.08)}

/* BOUTON */
.btn-main{width:100%;padding:13px;background:#1C54F0;color:#fff;border:none;border-radius:12px;font-size:13.5px;font-family:'IBM Plex Sans','Inter',sans-serif;font-weight:700;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px;letter-spacing:0.2px;box-shadow:4px 4px 14px rgba(0,0,0,0.5),-2px -2px 8px rgba(255,255,255,0.025),0 0 0 1px rgba(28,84,240,0.4)}
.btn-main:hover{background:#1444D0;box-shadow:0 8px 24px rgba(28,84,240,0.35)}
.btn-main:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}
.btn-back{background:none;border:none;color:rgba(255,255,255,0.3);font-size:13px;cursor:pointer;font-family:'Inter',sans-serif;margin-top:14px;display:flex;align-items:center;gap:4px;transition:color .2s;padding:0}
.btn-back:hover{color:rgba(255,255,255,0.6)}

/* ALERTS */
.err{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px 14px;font-size:13px;color:#f87171;margin-top:12px;display:none;line-height:1.5}
.ref-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);border-radius:6px;padding:5px 12px;font-size:12px;color:rgba(167,139,250,0.9);margin-bottom:20px}

.login-link{text-align:center;font-size:13px;color:rgba(255,255,255,0.25);margin-top:20px}
.login-link a{color:rgba(28,84,240,0.7);text-decoration:none;font-weight:500}
.login-link a:hover{color:#7BA4FF}

/* CONFIRMATION */
.confirm-icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px}
</style>
</head>
<body>
<div class="page">

  <!-- GAUCHE -->
  <div class="left">
    <div>
      <div class="logo">
<img src="logo.png" style="height:38px;object-fit:contain;filter:brightness(0) invert(1)"/>
      </div>
    </div>

    <div class="left-content">
      <div class="left-headline">Trouvez vos clients.<br><span>Automatiquement.</span></div>
      <div class="left-sub">Le CRM de prospection qui scanne le web, trouve vos prospects qualifiés et vous aide à les convertir — en quelques minutes.</div>

<div style="display:flex;flex-direction:column;gap:0;margin-top:8px">
      <div style="display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <div style="width:40px;height:40px;border-radius:10px;background:#0D0F14;border:1px solid rgba(28,84,240,0.25);box-shadow:4px 4px 10px rgba(0,0,0,0.6),-2px -2px 6px rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1C54F0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </div>
        <div>
          <div style="font-size:13.5px;font-weight:600;color:#fff;margin-bottom:3px">Scanner IA multi-sources</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.35);line-height:1.5">Pages Jaunes, Google Maps, LinkedIn, Facebook — jusqu'à 200 prospects en un clic</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <div style="width:40px;height:40px;border-radius:10px;background:#0D0F14;border:1px solid rgba(18,140,126,0.25);box-shadow:4px 4px 10px rgba(0,0,0,0.6),-2px -2px 6px rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#128C7E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div>
          <div style="font-size:13.5px;font-weight:600;color:#fff;margin-bottom:3px">WhatsApp & Email intégrés</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.35);line-height:1.5">Templates personnalisés, envoi direct depuis l'outil, suivi des relances</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <div style="width:40px;height:40px;border-radius:10px;background:#0D0F14;border:1px solid rgba(217,119,6,0.25);box-shadow:4px 4px 10px rgba(0,0,0,0.6),-2px -2px 6px rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="8.01" y2="14"/><line x1="12" y1="14" x2="12.01" y2="14"/><line x1="16" y1="14" x2="16.01" y2="14"/></svg>
        </div>
        <div>
          <div style="font-size:13.5px;font-weight:600;color:#fff;margin-bottom:3px">Agenda & Rendez-vous</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.35);line-height:1.5">Suivi setter/closer, rappels automatiques, pipeline de vente complet</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;padding:16px 0">
        <div style="width:40px;height:40px;border-radius:10px;background:#0D0F14;border:1px solid rgba(124,58,237,0.25);box-shadow:4px 4px 10px rgba(0,0,0,0.6),-2px -2px 6px rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        </div>
        <div>
          <div style="font-size:13.5px;font-weight:600;color:#fff;margin-bottom:3px">Statistiques & Pipeline</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.35);line-height:1.5">Taux de conversion, activité en temps réel, vue Kanban drag & drop</div>
        </div>
      </div>
    </div>
    </div>

    <div class="left-footer">© 2025 PushProspect · Alexis Kechichian · 07 59 53 64 75</div>
  </div>

  <!-- DROITE -->
  <div class="right">
    <div class="form-container">

      <div class="mobile-logo">
        <div class="mobile-logo-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <span class="mobile-logo-name">PushProspect</span>
      </div>

      ${refCode ? `<div class="ref-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Invitation partenaire · Code <strong>${refCode}</strong></div>` : ''}

      <!-- ÉTAPE 1 -->
      <div id="step1">
        <div class="progress-bar">
          <div class="progress-seg active" id="seg1"></div>
          <div class="progress-seg" id="seg2"></div>
          <div class="progress-seg" id="seg3"></div>
        </div>
        <div class="steps-header">
          <div class="step-label">Étape 1 sur 3</div>
          <div class="step-title">Créer votre espace</div>
          <div class="step-sub">Quelques secondes pour démarrer votre prospection</div>
        </div>

        <div class="field-row">
          <div class="field">
            <label class="field-label">Prénom & Nom</label>
            <input class="field-input" id="adminName" placeholder="Jean Dupont" autocomplete="name"/>
          </div>
          <div class="field">
            <label class="field-label">Identifiant *</label>
            <input class="field-input" id="adminLogin" placeholder="jean.dupont" autocomplete="username"/>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Nom de votre équipe / agence *</label>
          <input class="field-input" id="teamName" placeholder="Agence XYZ, Mon activité…" autocomplete="organization"/>
        </div>
        <div class="field">
          <label class="field-label">Mot de passe *</label>
          <input class="field-input" id="adminPass" type="password" placeholder="Min. 6 caractères" autocomplete="new-password" onkeydown="if(event.key==='Enter')goToPlans()"/>
        </div>

        <div class="err" id="err1"></div>
        <button class="btn-main" onclick="goToPlans()" style="margin-top:8px">
          Continuer
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <div class="login-link">Déjà un compte ? <a href="/">Se connecter</a></div>
      </div>

      <!-- ÉTAPE 2 -->
      <div id="step2" style="display:none">
        <div class="progress-bar">
          <div class="progress-seg done"></div>
          <div class="progress-seg active"></div>
          <div class="progress-seg"></div>
        </div>
        <div class="steps-header">
          <div class="step-label">Étape 2 sur 3</div>
          <div class="step-title">Choisir votre offre</div>
          <div class="step-sub">Crédits à vie · Sans abonnement · Rechargez quand vous voulez</div>
        </div>

        <div class="plans">
          <div class="plan" id="pc-free" onclick="selectPlan('free')">
            <div class="plan-check" id="chk-free"></div>
            <div class="plan-name">Gratuit</div>
            <div class="plan-price">0<span style="font-size:14px;color:rgba(255,255,255,0.4)">€</span></div>
            <div class="plan-credits">15 crédits offerts</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);line-height:1.5">Scanner IA · CRM · WhatsApp</div>
          </div>
          <div class="plan" id="pc-starter" onclick="selectPlan('starter')">
            <div class="plan-check" id="chk-starter"></div>
            <div class="plan-name">Starter</div>
            <div class="plan-price">25<span style="font-size:14px;color:rgba(255,255,255,0.4)">€</span></div>
            <div class="plan-credits">250 crédits</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);line-height:1.5">Tout Gratuit + Recharge</div>
          </div>
          <div class="plan" id="pc-pro" onclick="selectPlan('pro')" style="position:relative">
            <div class="plan-badge" style="background:#6366f1;color:#fff">⚡ Populaire</div>
            <div class="plan-check" id="chk-pro"></div>
            <div class="plan-name" style="margin-top:8px">Pro</div>
            <div class="plan-price">50<span style="font-size:14px;color:rgba(255,255,255,0.4)">€</span></div>
            <div class="plan-credits">500 crédits</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);line-height:1.5">Tout Starter inclus</div>
          </div>
          <div class="plan" id="pc-business" onclick="selectPlan('business')">
            <div class="plan-check" id="chk-business"></div>
            <div class="plan-name">Business</div>
            <div class="plan-price">150<span style="font-size:14px;color:rgba(255,255,255,0.4)">€</span></div>
            <div class="plan-credits">1 500 crédits</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);line-height:1.5">Tout Pro inclus</div>
          </div>
        </div>

        <div class="plan-agency" id="pc-agency" onclick="selectPlan('agency')">
          <div style="width:36px;height:36px;border-radius:8px;background:rgba(139,92,246,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          </div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">Agence — Leads illimités</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.35)">Tarif sur mesure · Contactez-nous</div>
          </div>
          <div class="plan-check" id="chk-agency"></div>
        </div>

        <div class="err" id="err2"></div>
        <button class="btn-main" id="plan-confirm-btn" onclick="confirmPlan()" disabled>
          Confirmer
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="btn-back" onclick="backToStep1()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Retour
        </button>
      </div>

      <!-- ÉTAPE 3 -->
      <div id="step3" style="display:none">
        <div class="progress-bar">
          <div class="progress-seg done"></div>
          <div class="progress-seg done"></div>
          <div class="progress-seg active"></div>
        </div>
        <div id="step3-content"></div>
        <div class="err" id="err3"></div>
      </div>

    </div>
  </div>
</div>

<script>
function getFingerprint(){try{var c=document.createElement('canvas');var x=c.getContext('2d');x.fillText('fp',2,2);var d=[navigator.userAgent,navigator.language,screen.width+'x'+screen.height,screen.colorDepth,new Date().getTimezoneOffset(),navigator.hardwareConcurrency||'',c.toDataURL().slice(-50)].join('|');var h=0;for(var i=0;i<d.length;i++){h=((h<<5)-h)+d.charCodeAt(i);h=h&h;}return Math.abs(h).toString(36);}catch(e){return Math.random().toString(36);}}

var PLANS_DATA={free:{name:'Gratuit',credits:15,price:0},starter:{name:'Starter',credits:250,price:25},pro:{name:'Pro',credits:500,price:50},business:{name:'Business',credits:1500,price:150},agency:{name:'Agence',credits:0,price:0}};
var selectedPlan=null;
var formData={};

function goToPlans(){
  try{
    var teamName=(document.getElementById('teamName').value||'').trim();
    var adminLogin=(document.getElementById('adminLogin').value||'').trim();
    var adminPass=document.getElementById('adminPass').value||'';
    var adminName=(document.getElementById('adminName').value||'').trim();
    var err=document.getElementById('err1');
    err.style.display='none';
    if(!teamName){err.textContent='Le nom de lequipe est obligatoire.';err.style.display='block';return;}
    if(!adminLogin){err.textContent='Lidentifiant est obligatoire.';err.style.display='block';return;}
    if(adminPass.length<6){err.textContent='Mot de passe : 6 caractères minimum.';err.style.display='block';return;}
formData.teamName=teamName;
    formData.adminLogin=adminLogin;
    formData.adminPass=adminPass;
    formData.adminName=adminName;
    document.getElementById('step1').style.display='none';
    document.getElementById('step2').style.display='block';
  }catch(e){
    var errEl=document.getElementById('err1');
    if(errEl){errEl.textContent='Erreur: '+e.message;errEl.style.display='block';}
    console.error('goToPlans error:',e);
  }
}

function backToStep1(){
  document.getElementById('step2').style.display='none';
  document.getElementById('step1').style.display='block';
}

function selectPlan(id){
  selectedPlan=id;
  ['free','starter','pro','business','agency'].forEach(function(p){
    var card=document.getElementById('pc-'+p);
    var chk=document.getElementById('chk-'+p);
    if(card)card.classList.remove('selected');
    if(chk)chk.textContent='';
  });
  var card=document.getElementById('pc-'+id);
  var chk=document.getElementById('chk-'+id);
  if(card)card.classList.add('selected');
  if(chk)chk.textContent='✓';
  document.getElementById('plan-confirm-btn').disabled=false;
  document.getElementById('err2').style.display='none';
}

function confirmPlan(){
  if(!selectedPlan)return;
  if(selectedPlan==='agency'){
window.open('https://wa.me/33759536475?text='+encodeURIComponent('Bonjour, je suis interesse par loffre Agence PushProspect. Equipe : '+formData.teamName),'_blank');

    return;
  }
  document.getElementById('step2').style.display='none';
  document.getElementById('step3').style.display='block';
  var s3=document.getElementById('step3-content');
  var theRefCode='${refCode}';

  if(selectedPlan==='free'){
    s3.innerHTML='<div style="text-align:center;padding:20px 0"><div style="width:56px;height:56px;border-radius:50%;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 16px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div><div style="font-size:18px;font-weight:700;margin-bottom:6px">Création en cours…</div><div style="font-size:13px;color:rgba(255,255,255,0.35)">Votre espace se prépare</div></div>';
    fetch('/teams/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({},formData,{plan:'free',refCode:theRefCode}))})
    .then(function(r){return r.json().then(function(d){return{status:r.status,ok:r.ok,data:d};});})
    .then(function(res){
      if(res.status===429){showErr3('Un compte a déjà été créé depuis votre connexion. Contactez le support : 07 59 53 64 75');return;}
      if(!res.ok){showErr3(res.data.error||'Erreur création');return;}
      s3.innerHTML='<div style="text-align:center;padding:20px 0"><div style="width:64px;height:64px;border-radius:50%;background:rgba(16,185,129,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 20px"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div><div style="font-size:22px;font-weight:700;margin-bottom:8px">Compte créé !</div><div style="font-size:14px;color:rgba(255,255,255,0.4);margin-bottom:24px">15 crédits offerts · Redirection en cours…</div></div>';
      setTimeout(function(){window.location.href='/';},2000);
    })
    .catch(function(e){showErr3('Erreur réseau : '+e.message);});
  } else {
    s3.innerHTML='<div style="text-align:center;padding:20px 0"><div style="width:56px;height:56px;border-radius:50%;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 16px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div><div style="font-size:18px;font-weight:700;margin-bottom:6px">Redirection paiement…</div><div style="font-size:13px;color:rgba(255,255,255,0.35)">Vous allez être redirigé vers Stripe</div></div>';
    fetch('/teams/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({},formData,{plan:'pending',refCode:theRefCode}))})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d};});})
    .then(function(res){
      if(!res.ok){showErr3(res.data.error||'Erreur création');return;}
      return fetch('/stripe/create-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:selectedPlan,teamId:res.data.teamId,userId:res.data.adminId,refCode:theRefCode})});
    })
    .then(function(r){if(!r)return;return r.json().then(function(d){return{ok:r.ok,data:d};});})
    .then(function(res){
      if(!res||!res.ok||!res.data.url){showErr3((res&&res.data.error)||'Erreur Stripe');return;}
      window.location.href=res.data.url;
    })
    .catch(function(e){showErr3('Erreur réseau : '+e.message);});
  }
}

function showErr3(msg){
  document.getElementById('step3-content').innerHTML='<div style="text-align:center;padding:20px 0"><div style="width:56px;height:56px;border-radius:50%;background:rgba(239,68,68,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 16px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div style="font-size:18px;font-weight:700;margin-bottom:6px">Une erreur est survenue</div></div>';
  var el=document.getElementById('err3');
  el.textContent=msg;
  el.style.display='block';
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

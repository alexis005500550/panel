// ═══════════════════════════════════════════════════════════════════
//  PushProspect — Proxy Gemini + Persistance disque + WhatsApp Auto
//  node server.js
// ═══════════════════════════════════════════════════════════════════

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
try { require('dotenv').config(); } catch(e) {}

const API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) { console.error('❌ GEMINI_API_KEY manquante'); process.exit(1); }
const PORT = process.env.PORT || 8080;
const MODEL = 'gemini-2.5-pro';


const DATA_DIR = path.join(__dirname, 'data');
const WA_DIR   = path.join(__dirname, 'wa_session');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WA_DIR))   fs.mkdirSync(WA_DIR,   { recursive: true });

// ══ GMAIL OAuth — constantes et helpers (hors serveur, c'est correct ici) ══
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT_URI  = `http://localhost:${PORT}/gmail/callback`;
const GMAIL_TOKEN_FILE    = path.join(DATA_DIR, 'gmail_token.json');

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
  contacts : path.join(DATA_DIR, 'contacts.json'),
  users    : path.join(DATA_DIR, 'users.json'),
  agenda   : path.join(DATA_DIR, 'agenda.json'),
  blocked  : path.join(DATA_DIR, 'blocked.json'),
  activity : path.join(DATA_DIR, 'activity.json'),
  messages : path.join(DATA_DIR, 'messages.json'),
  teams    : path.join(DATA_DIR, 'teams.json'),
  rdv      : path.join(DATA_DIR, 'rdv.json'),
  emails   : path.join(DATA_DIR, 'emails.json'),
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

  // ── HTML principal ──
  // ── HTML principal ──
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const f = path.join(__dirname, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('<h2>index.html introuvable</h2>'); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(fs.readFileSync(f)); return;
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
      const { teamName, adminLogin, adminPass, adminName, expiresAt } = await parseBody(req);
      if (!teamName || !adminLogin || !adminPass) {
        jsonResp(res, 400, { error: 'teamName, adminLogin, adminPass requis' }); return;
      }
      const users = readDB('users');
      if (users.find(u => u.login === adminLogin)) {
        jsonResp(res, 400, { error: 'Identifiant déjà utilisé' }); return;
      }
      const teamId = 'team_' + Date.now();
      const adminId = 'user_' + Date.now() + '_admin';
      const teams = readDB('teams');
      teams.push({
        id: teamId, name: teamName, ownerId: adminId,
        createdAt: new Date().toISOString().split('T')[0],
        subscription: {
          status: 'active',
          expiresAt: expiresAt || null,
          plan: 'starter'
        }
      });
      users.push({
        id: adminId, login: adminLogin, name: adminName || adminLogin,
        pass: adminPass, role: 'admin', teamId,
        created: new Date().toISOString().split('T')[0]
      });
      writeDB('teams', teams);
      writeDB('users', users);
      console.log(`  ✅ Équipe créée : ${teamName} (admin: ${adminLogin})`);
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
  if (req.method === 'POST' && url === '/api') {
    try {
      const incoming = await parseBody(req);
      const { status, body: gR } = await callGemini(anthropicToGemini(incoming));
      if (status !== 200) {
        const msg = (gR.error||{}).message || JSON.stringify(gR).slice(0,200);
        jsonResp(res, status, { error:{ type:'api_error', message:`Gemini ${status}: ${msg}` } }); return;
      }
      const out = geminiToAnthropic(gR);
      console.log(`  ✓ /api — ${out.content.filter(b=>b.type==='tool_use').length} recherche(s) · ${new Date().toLocaleTimeString()}`);
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

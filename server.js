// ═══════════════════════════════════════════════════════════════════
//  ProspectFlow — Proxy Gemini + Persistance disque + WhatsApp Auto
//  node server.js
// ═══════════════════════════════════════════════════════════════════

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const API_KEY  = process.env.GEMINI_API_KEY || 'AIzaSyCWjKF4T-3RnKbckdAQsIQ_1SlNu0eCpTQ';
const PORT     = 3000;
const MODEL    = 'gemini-2.5-flash';
const DATA_DIR = path.join(__dirname, 'data');
const WA_DIR   = path.join(__dirname, 'wa_session');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WA_DIR))   fs.mkdirSync(WA_DIR,   { recursive: true });

// ── DB ──────────────────────────────────────────────────────────────
const DB_FILES = {
  contacts : path.join(DATA_DIR, 'contacts.json'),
  users    : path.join(DATA_DIR, 'users.json'),
  agenda   : path.join(DATA_DIR, 'agenda.json'),
  blocked  : path.join(DATA_DIR, 'blocked.json'),
  activity : path.join(DATA_DIR, 'activity.json'),
  messages : path.join(DATA_DIR, 'messages.json'),
};
function readDB(key) {
  try { if (fs.existsSync(DB_FILES[key])) return JSON.parse(fs.readFileSync(DB_FILES[key], 'utf8')); }
  catch (e) { console.error('readDB error', key, e.message); }
  if (key === 'users') return [{ id:'admin', login:'admin', name:'Admin', pass:'admin123', role:'admin', created: new Date().toISOString().split('T')[0] }];
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
    // Supprimer la session corrompue et recommencer
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

// Formater numéro → format WhatsApp
function formatPhone(phone) {
  let n = phone.replace(/[\s.\-+()\[\]]/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('0'))  n = '33' + n.slice(1);
  if (n.length <= 10 && !n.startsWith('33')) n = '33' + n;
  return n + '@c.us';
}

// Envoyer un message
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
  return { contents, tools:[{ googleSearch:{} }], generationConfig:{ maxOutputTokens: incoming.max_tokens||8192, temperature:1.0 } };
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
    req.setTimeout(120000,()=>{req.destroy();reject(new Error('Timeout 120s'));});
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
  <p style="color:#555">ProspectFlow peut envoyer des messages automatiquement.</p>
  <p style="color:#999;font-size:12px">Fermez cette page et retournez sur ProspectFlow.</p></div></body></html>`;

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

// ══════════════════════════════════════════════════════════════════
//  SERVEUR
// ══════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // HTML principal
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const f = path.join(__dirname, 'prospectflow.html');
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('<h2>prospectflow.html introuvable</h2>'); return; }
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(fs.readFileSync(f)); return;
  }

  // /health
  if (req.method === 'GET' && url === '/health') {
    const counts = {};
    for (const k of Object.keys(DB_FILES)) { try{counts[k]=(readDB(k)||[]).length;}catch(e){counts[k]=0;} }
    jsonResp(res, 200, { ok:true, provider:'Google Gemini', model:MODEL, key:'…'+API_KEY.slice(-6), persistence:'disk',
      whatsapp:{ status:waStatus, connected:waStatus==='connected', user:waClient?.info?.pushname||null }, counts });
    return;
  }

  // /wa/qr — Page QR
  if (req.method === 'GET' && url === '/wa/qr') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(qrPageHTML(waQR, waStatus)); return;
  }

  // /wa/status — JSON
  if (req.method === 'GET' && url === '/wa/status') {
    jsonResp(res, 200, { status:waStatus, connected:waStatus==='connected', hasQR:!!waQR, user:waClient?.info?.pushname||null });
    return;
  }

  // /wa/disconnect
  if (req.method === 'POST' && url === '/wa/disconnect') {
    try { if (waClient) await waClient.destroy().catch(()=>{}); } catch(e) {}
    waClient = null; waStatus = 'disconnected'; waQR = null;
    try { fs.rmSync(WA_DIR,{recursive:true,force:true}); fs.mkdirSync(WA_DIR,{recursive:true}); } catch(e) {}
    jsonResp(res, 200, { ok:true }); return;
  }

  // /wa/send — Envoi automatique
  if (req.method === 'POST' && url === '/wa/send') {
    try {
      const { phone, message, contactId, contactName, situation, templateId, niche, ville } = await parseBody(req);
      if (!phone || !message) { jsonResp(res, 400, { error:'phone et message requis' }); return; }

      const result = await sendWAMessage(phone, message);

      // Log DB
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

  // /api — Proxy Gemini
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

  // /db/:key — Persistance
  const dbMatch = url.match(/^\/db\/(\w+)$/);
  if (dbMatch) {
    const key = dbMatch[1];
    if (!DB_FILES[key]) { jsonResp(res, 404, { error:'Unknown key' }); return; }
    if (req.method === 'GET') { jsonResp(res, 200, { data:readDB(key) }); return; }
    if (req.method === 'POST') {
      try { const b = await parseBody(req); jsonResp(res, writeDB(key,b.data)?200:500, { ok:writeDB(key,b.data) }); }
      catch(e) { jsonResp(res, 400, { error:e.message }); }
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, async () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║   ProspectFlow — Gemini + Persistance + WhatsApp Auto   ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  👉  App     : http://localhost:' + PORT);
  console.log('  📱  QR WA   : http://localhost:' + PORT + '/wa/qr');
  console.log('  🔑  Gemini  : …' + API_KEY.slice(-8));
  console.log('  💾  Data    : ' + DATA_DIR);
  console.log('  📁  Session : ' + WA_DIR);
  console.log('');
  //await initWhatsApp();
});
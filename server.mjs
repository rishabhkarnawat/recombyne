import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = normalize(__filename.replace(/[/\\][^/\\]+$/, ''));

loadDotEnv(join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_WAITLIST_TABLE = process.env.SUPABASE_WAITLIST_TABLE || 'waitlist_signups';
const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN || '';
const WAITLIST_NOTIFY_WEBHOOK_URL = process.env.WAITLIST_NOTIFY_WEBHOOK_URL || '';
const WAITLIST_NOTIFY_WEBHOOK_BEARER = process.env.WAITLIST_NOTIFY_WEBHOOK_BEARER || '';
const WAITLIST_ALERT_WEBHOOK_URL = process.env.WAITLIST_ALERT_WEBHOOK_URL || '';
const WAITLIST_ALERT_WEBHOOK_BEARER = process.env.WAITLIST_ALERT_WEBHOOK_BEARER || '';
const MAX_INPUT_CHARS = 1200;
const MAX_HISTORY_ITEMS = 6;
const WAITLIST_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const WAITLIST_RATE_LIMIT_MAX = 8;
const waitlistRateMap = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const cleaned = decoded === '/' ? '/index.html' : decoded === '/admin' ? '/admin.html' : decoded;
  const resolved = normalize(join(__dirname, cleaned));
  if (!resolved.startsWith(__dirname)) return null;
  return resolved;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cleanText(v, maxLen = MAX_INPUT_CHARS) {
  return String(v || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function buildPrompt(system, history, message) {
  const cleanSystem = cleanText(system, 5000);
  const historyLines = history
    .slice(-MAX_HISTORY_ITEMS)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${cleanText(m.content, 500)}`)
    .join('\n');

  return `${cleanSystem}\n\nPrior turns:\n${historyLines || '(none)'}\n\nUser: ${message}\nAssistant:`;
}

async function handleChat(req, res) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, { error: 'Missing GEMINI_API_KEY in .env' });
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    const message = cleanText(body.message);
    const system = cleanText(body.system, 7000);
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return sendJson(res, 400, { error: 'Message is required' });
    }

    const prompt = buildPrompt(system, history, message);
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const modelRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.8,
          maxOutputTokens: 220
        }
      })
    });

    if (!modelRes.ok) {
      const errText = await modelRes.text();
      return sendJson(res, 502, { error: 'Model API error', detail: errText.slice(0, 500) });
    }

    const modelJson = await modelRes.json();
    const reply =
      modelJson?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '')
        .join('')
        .trim() || '';

    return sendJson(res, 200, {
      reply: reply || 'I can help with Recombyne product details, pricing, launch timing, and use cases.'
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'Failed to process chat request', detail: String(err.message || err) });
  }
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = waitlistRateMap.get(ip);
  if (!record || now - record.windowStart > WAITLIST_RATE_LIMIT_WINDOW_MS) {
    waitlistRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= WAITLIST_RATE_LIMIT_MAX) return false;
  record.count += 1;
  waitlistRateMap.set(ip, record);
  return true;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function supabaseRequest(path, init = {}) {
  const endpoint = `${SUPABASE_URL}/rest/v1/${path.replace(/^\/+/, '')}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...init.headers
  };
  return fetch(endpoint, { ...init, headers });
}

async function notifyWaitlistSignup(payload) {
  if (!WAITLIST_NOTIFY_WEBHOOK_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (WAITLIST_NOTIFY_WEBHOOK_BEARER) {
      headers.Authorization = `Bearer ${WAITLIST_NOTIFY_WEBHOOK_BEARER}`;
    }
    await fetch(WAITLIST_NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  } catch {
    // Notification failure should not block signup.
  }
}

async function notifyWaitlistAlert(payload) {
  if (!WAITLIST_ALERT_WEBHOOK_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (WAITLIST_ALERT_WEBHOOK_BEARER) {
      headers.Authorization = `Bearer ${WAITLIST_ALERT_WEBHOOK_BEARER}`;
    }
    await fetch(WAITLIST_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  } catch {
    // Alert failures should not crash API requests.
  }
}

function toCsv(rows) {
  const headers = ['email', 'role', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'created_at'];
  const escapeCell = (val) => {
    const text = val == null ? '' : String(val);
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\n');
}

async function handleWaitlist(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    await notifyWaitlistAlert({
      event: 'waitlist_error',
      stage: 'config',
      message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
      time: new Date().toISOString()
    });
    return sendJson(res, 500, {
      error: 'Supabase not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env'
    });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    await notifyWaitlistAlert({
      event: 'waitlist_error',
      stage: 'rate_limit',
      ip,
      message: 'Rate limit exceeded',
      time: new Date().toISOString()
    });
    return sendJson(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    const email = cleanText(body.email, 320).toLowerCase();
    const role = cleanText(body.role, 120);
    const source = cleanText(body.source || 'landing_page', 80);
    const utm_source = cleanText(body.utm_source, 120);
    const utm_medium = cleanText(body.utm_medium, 120);
    const utm_campaign = cleanText(body.utm_campaign, 120);
    const user_agent = cleanText(req.headers['user-agent'] || '', 500);

    if (!email || !isValidEmail(email)) {
      await notifyWaitlistAlert({
        event: 'waitlist_error',
        stage: 'validation',
        ip,
        email,
        message: 'Invalid email',
        time: new Date().toISOString()
      });
      return sendJson(res, 400, { error: 'Valid email is required' });
    }
    if (!role) {
      await notifyWaitlistAlert({
        event: 'waitlist_error',
        stage: 'validation',
        ip,
        email,
        message: 'Missing role',
        time: new Date().toISOString()
      });
      return sendJson(res, 400, { error: 'Role is required' });
    }

    const existingRes = await supabaseRequest(
      `${encodeURIComponent(SUPABASE_WAITLIST_TABLE)}?select=id,created_at&email=eq.${encodeURIComponent(email)}&limit=1`,
      { method: 'GET' }
    );
    if (!existingRes.ok) {
      const errText = await existingRes.text();
      await notifyWaitlistAlert({
        event: 'waitlist_error',
        stage: 'existing_check',
        ip,
        email,
        message: errText.slice(0, 400),
        time: new Date().toISOString()
      });
      return sendJson(res, 502, { error: 'Failed to check waitlist status', detail: errText.slice(0, 500) });
    }
    const existingRows = await existingRes.json();
    if (Array.isArray(existingRows) && existingRows.length > 0) {
      return sendJson(res, 200, {
        ok: true,
        status: 'already_exists',
        message: "You're already on the waitlist."
      });
    }

    const insertPayload = {
      email,
      role,
      source,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      user_agent: user_agent || null,
      ip_address: ip || null
    };

    const dbRes = await supabaseRequest(`${encodeURIComponent(SUPABASE_WAITLIST_TABLE)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(insertPayload)
    });

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      if (errText.includes('"code":"23505"') || errText.includes('duplicate key value')) {
        return sendJson(res, 200, {
          ok: true,
          status: 'already_exists',
          message: "You're already on the waitlist."
        });
      }
      await notifyWaitlistAlert({
        event: 'waitlist_error',
        stage: 'insert',
        ip,
        email,
        message: errText.slice(0, 400),
        time: new Date().toISOString()
      });
      return sendJson(res, 502, { error: 'Failed to save waitlist signup', detail: errText.slice(0, 500) });
    }

    await notifyWaitlistSignup({
      event: 'waitlist_signup',
      email,
      role,
      source,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      created_at: new Date().toISOString()
    });

    return sendJson(res, 200, { ok: true, status: 'created', message: "You're on the list." });
  } catch (err) {
    await notifyWaitlistAlert({
      event: 'waitlist_error',
      stage: 'exception',
      ip,
      message: String(err.message || err).slice(0, 400),
      time: new Date().toISOString()
    });
    return sendJson(res, 500, { error: 'Failed to process waitlist request', detail: String(err.message || err) });
  }
}

async function handleWaitlistExport(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { error: 'Supabase not configured' });
  }
  if (!ADMIN_EXPORT_TOKEN) {
    return sendJson(res, 500, { error: 'Missing ADMIN_EXPORT_TOKEN in .env' });
  }

  const reqUrl = new URL(req.url || '/api/waitlist/export', `http://${req.headers.host || 'localhost'}`);
  const token = reqUrl.searchParams.get('token') || req.headers['x-admin-token'] || '';
  if (token !== ADMIN_EXPORT_TOKEN) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const select = 'email,role,source,utm_source,utm_medium,utm_campaign,created_at';
  const path = `${encodeURIComponent(SUPABASE_WAITLIST_TABLE)}?select=${encodeURIComponent(select)}&order=created_at.desc`;
  const dataRes = await supabaseRequest(path, { method: 'GET' });
  if (!dataRes.ok) {
    const errText = await dataRes.text();
    return sendJson(res, 502, { error: 'Failed to export waitlist', detail: errText.slice(0, 500) });
  }
  const rows = await dataRes.json();
  const csv = toCsv(Array.isArray(rows) ? rows : []);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="waitlist-export-${new Date().toISOString().slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store'
  });
  res.end(csv);
}

function handleHealth(req, res) {
  const host = req.headers.host || 'localhost';
  return sendJson(res, 200, {
    ok: true,
    service: 'recombyne',
    status: 'healthy',
    time: new Date().toISOString(),
    checks: {
      gemini_configured: Boolean(GEMINI_API_KEY),
      supabase_configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
      export_token_configured: Boolean(ADMIN_EXPORT_TOKEN)
    },
    urls: {
      home: `https://${host}`,
      health: `https://${host}/api/health`
    }
  });
}

function handleAdminPage(req, res) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Recombyne Admin Export</title>
  <style>
    :root { --bg:#0b0b0b; --panel:#151515; --ink:#f3f3f3; --muted:#9a9a9a; --accent:#00a86b; --line:#2a2a2a; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:radial-gradient(circle at top, #1a1a1a, var(--bg)); color:var(--ink); font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
    .card { width:min(560px,100%); background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:28px; box-shadow:0 25px 60px rgba(0,0,0,.35); }
    h1 { margin:0 0 8px; font-size:24px; letter-spacing:-.01em; }
    p { margin:0 0 20px; color:var(--muted); line-height:1.5; }
    label { display:block; margin-bottom:8px; font-size:13px; color:var(--muted); }
    input { width:100%; border:1px solid var(--line); background:#101010; color:var(--ink); border-radius:10px; padding:12px 14px; font-size:14px; outline:none; }
    input:focus { border-color:var(--accent); }
    .row { display:flex; gap:10px; margin-top:14px; }
    button { border:none; border-radius:10px; padding:12px 14px; font-size:14px; cursor:pointer; }
    .btn-primary { background:var(--accent); color:#fff; font-weight:600; }
    .btn-ghost { background:#1f1f1f; color:var(--ink); border:1px solid var(--line); }
    .status { margin-top:14px; min-height:20px; font-size:13px; color:var(--muted); }
    code { background:#111; border:1px solid var(--line); border-radius:6px; padding:2px 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Waitlist CSV Export</h1>
    <p>Use your <code>ADMIN_EXPORT_TOKEN</code> to securely download the current waitlist as CSV.</p>
    <label for="token">Admin Export Token</label>
    <input id="token" type="password" placeholder="Paste export token" autocomplete="off" />
    <div class="row">
      <button id="downloadBtn" class="btn-primary">Download CSV</button>
      <button id="clearBtn" class="btn-ghost" type="button">Clear</button>
    </div>
    <div class="status" id="status"></div>
  </div>
  <script>
    const tokenInput = document.getElementById('token');
    const downloadBtn = document.getElementById('downloadBtn');
    const clearBtn = document.getElementById('clearBtn');
    const statusEl = document.getElementById('status');
    async function downloadCsv() {
      const token = tokenInput.value.trim();
      if (!token) { statusEl.textContent = 'Token is required.'; return; }
      statusEl.textContent = 'Preparing CSV...'; downloadBtn.disabled = true;
      try {
        const res = await fetch('/api/waitlist/export', { method: 'GET', headers: { 'x-admin-token': token } });
        if (!res.ok) { statusEl.textContent = res.status === 401 ? 'Invalid token.' : 'Export failed.'; return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'waitlist-export.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        statusEl.textContent = 'Download started.';
      } catch { statusEl.textContent = 'Could not reach export endpoint.'; }
      finally { downloadBtn.disabled = false; }
    }
    downloadBtn.addEventListener('click', downloadCsv);
    tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') downloadCsv(); });
    clearBtn.addEventListener('click', () => { tokenInput.value = ''; statusEl.textContent = ''; tokenInput.focus(); });
  </script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

async function serveStatic(req, res) {
  const safePath = safePublicPath(req.url || '/');
  if (!safePath) return sendText(res, 400, 'Bad request');

  try {
    const fileStat = await stat(safePath);
    if (!fileStat.isFile()) return sendText(res, 404, 'Not found');
    const ext = extname(safePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    createReadStream(safePath).pipe(res);
  } catch {
    if ((req.url || '/') !== '/index.html' && (req.url || '/') !== '/') {
      return sendText(res, 404, 'Not found');
    }
    const html = await readFile(join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method === 'POST' && url === '/api/chat') {
    return handleChat(req, res);
  }
  if (req.method === 'POST' && url === '/api/waitlist') {
    return handleWaitlist(req, res);
  }
  if (req.method === 'GET' && url.startsWith('/api/waitlist/export')) {
    return handleWaitlistExport(req, res);
  }
  if (req.method === 'GET' && url === '/api/health') {
    return handleHealth(req, res);
  }
  if (req.method === 'GET' && url === '/api/admin') {
    return handleAdminPage(req, res);
  }
  if (req.method === 'GET' && url === '/admin') {
    return handleAdminPage(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }
  return sendText(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Recombyne server running on http://localhost:${PORT}`);
});

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

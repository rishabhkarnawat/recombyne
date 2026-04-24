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
  const cleaned = decoded === '/' ? '/index.html' : decoded;
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
    return sendJson(res, 500, {
      error: 'Supabase not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env'
    });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
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
      return sendJson(res, 400, { error: 'Valid email is required' });
    }
    if (!role) {
      return sendJson(res, 400, { error: 'Role is required' });
    }

    const existingRes = await supabaseRequest(
      `${encodeURIComponent(SUPABASE_WAITLIST_TABLE)}?select=id,created_at&email=eq.${encodeURIComponent(email)}&limit=1`,
      { method: 'GET' }
    );
    if (!existingRes.ok) {
      const errText = await existingRes.text();
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

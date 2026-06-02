const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer: зберігаємо файли в пам'яті (Render free = 512MB RAM, тримай < 20MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB hard limit
});

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const { randomUUID } = require('crypto');

let ADMIN_KEY = process.env.ADMIN_KEY ?? '';
if (!ADMIN_KEY) {
  ADMIN_KEY = randomUUID();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║         🔑 ADMIN KEY (згенеровано авто)          ║');
  console.log(`║  ${ADMIN_KEY}  ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
} else {
  console.log('🔑 ADMIN_KEY завантажено з env');
}

// ─── Живий конфіг ──────────────────────────────────────────────────────────
const config = {
  showReasoning:      process.env.SHOW_REASONING === 'true',
  enableThinking:     process.env.ENABLE_THINKING === 'true',
  maxRetries:         parseInt(process.env.MAX_RETRIES ?? '2'),
  retryDelayMs:       parseInt(process.env.RETRY_DELAY_MS ?? '1000'),
  max429Retries:      parseInt(process.env.MAX_429_RETRIES ?? '3'),
  retry429DelayMs:    parseInt(process.env.RETRY_429_DELAY_MS ?? '5000'),
  defaultTemperature: parseFloat(process.env.DEFAULT_TEMPERATURE ?? '0.6'),
  defaultMaxTokens:   parseInt(process.env.DEFAULT_MAX_TOKENS ?? '2048'),
  timeoutMs:          parseInt(process.env.TIMEOUT_MS ?? '120000'),
};

// ─── Статистика ────────────────────────────────────────────────────────────
const stats = {
  total: 0, success: 0,
  err429: 0, err5xx: 0, errOther: 0,
  byEndpoint: {},
  startTime: Date.now(),
};

function trackEndpoint(name) {
  stats.byEndpoint[name] = (stats.byEndpoint[name] ?? 0) + 1;
}

// ─── Retry логіка ──────────────────────────────────────────────────────────
async function fetchWithRetry(axiosConfig) {
  let attempts5xx = 0, attempts429 = 0;
  while (true) {
    try {
      return await axios(axiosConfig);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempts429 < config.max429Retries) {
        attempts429++; stats.err429++;
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] ?? '0') * 1000;
        const delay = retryAfter > 0 ? retryAfter : config.retry429DelayMs;
        console.log(`[429] Retry ${attempts429}/${config.max429Retries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (status >= 500 && attempts5xx < config.maxRetries) {
        attempts5xx++; stats.err5xx++;
        const delay = config.retryDelayMs * Math.pow(2, attempts5xx - 1);
        console.log(`[${status}] Retry ${attempts5xx}/${config.maxRetries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ─── Хелпер: витягнути API ключ ────────────────────────────────────────────
function extractApiKey(req) {
  const authHeader = req.headers['authorization'] ?? '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!raw) return null;
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}

// ─── Хелпер: стандартна обробка помилок ───────────────────────────────────
function handleError(err, res) {
  const status = err.response?.status ?? 500;
  const rawData = err.response?.data;
  let message = 'Помилка';
  if (rawData?.detail) message = typeof rawData.detail === 'string' ? rawData.detail : JSON.stringify(rawData.detail);
  else if (rawData?.error?.message) message = rawData.error.message;
  else message = err.message;
  if (status !== 429 && status < 500) stats.errOther++;
  console.error(`[${status}]`, JSON.stringify(rawData ?? err.message));
  if (!res.headersSent) res.status(status).json({ error: { message, code: status } });
}

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── ADMIN HTML ─────────────────────────────────────────────────────────────
function buildAdminHtml() {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NIM Universal Proxy</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f13;color:#e0e0e0;font-family:-apple-system,sans-serif;padding:16px;max-width:520px;margin:0 auto;padding-bottom:40px}
    h1{font-size:22px;color:#fff;margin-bottom:2px}
    .sub{font-size:13px;color:#555;margin-bottom:20px}
    .stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
    .stat{background:#1a1a24;border-radius:12px;padding:12px;text-align:center}
    .stat-val{font-size:24px;font-weight:700;color:#76b900}
    .stat-lbl{font-size:11px;color:#555;margin-top:2px}
    .stat.err .stat-val{color:#ff4455}
    .stat.warn .stat-val{color:#ffaa00}
    .card{background:#1a1a24;border-radius:14px;padding:16px;margin-bottom:12px}
    .card-title{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#76b900;margin-bottom:12px;font-weight:600}
    .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #22222f}
    .row:last-child{border-bottom:none}
    .lbl{font-size:15px}.desc{font-size:12px;color:#555;margin-top:2px}
    .toggle{position:relative;width:46px;height:26px;flex-shrink:0}
    .toggle input{opacity:0;width:0;height:0}
    .sl{position:absolute;inset:0;background:#2a2a3a;border-radius:26px;cursor:pointer;transition:.2s}
    .sl:before{content:'';position:absolute;width:20px;height:20px;left:3px;top:3px;background:#888;border-radius:50%;transition:.2s}
    input:checked+.sl{background:#76b900}
    input:checked+.sl:before{transform:translateX(20px);background:#fff}
    .num{background:#22222f;border:1px solid #2e2e40;color:#fff;padding:6px 10px;border-radius:8px;width:96px;font-size:15px;text-align:right}
    .num:focus{outline:none;border-color:#76b900}
    #keyWrap{margin-bottom:16px}
    #keyInput{background:#22222f;border:1px solid #2e2e40;color:#fff;padding:10px 12px;border-radius:10px;width:100%;font-size:15px}
    .btn{width:100%;padding:14px;background:#76b900;border:none;border-radius:12px;color:#000;font-size:16px;font-weight:700;cursor:pointer}
    .btn:active{opacity:.85}
    #status{text-align:center;margin-top:12px;font-size:14px;min-height:20px}
    .ok{color:#76b900}.errt{color:#ff4455}
    .uptime{font-size:11px;color:#444;text-align:center;margin-bottom:16px}
    .ep-grid{display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:13px}
    .ep-name{color:#aaa}.ep-cnt{color:#76b900;text-align:right;font-weight:600}
    .badge{display:inline-block;background:#22222f;color:#76b900;font-size:10px;padding:2px 6px;border-radius:6px;margin:2px}
    .endpoints-info{background:#12121a;border-radius:10px;padding:12px;margin-top:4px;font-size:12px;color:#666;line-height:1.8}
    code{background:#1e1e2e;padding:1px 5px;border-radius:4px;color:#a0c080;font-size:11px}
  </style>
</head>
<body>
  <h1>🚀 NIM Universal Proxy</h1>
  <p class="sub">Підтримує: chat · embeddings · images · audio · vision · TTS · STT</p>

  <div class="stats" id="statsGrid">
    <div class="stat"><div class="stat-val" id="sTotal">—</div><div class="stat-lbl">Всього запитів</div></div>
    <div class="stat"><div class="stat-val" id="sSuccess">—</div><div class="stat-lbl">Успішних</div></div>
    <div class="stat warn"><div class="stat-val" id="s429">—</div><div class="stat-lbl">429 rate limit</div></div>
    <div class="stat err"><div class="stat-val" id="s5xx">—</div><div class="stat-lbl">5xx помилки</div></div>
  </div>
  <div class="uptime" id="uptimeEl"></div>

  <div class="card">
    <div class="card-title">📡 Запити по ендпоінтах</div>
    <div class="ep-grid" id="epGrid"><div class="ep-name" style="color:#444">Поки немає даних</div><div></div></div>
  </div>

  <div class="card">
    <div class="card-title">🔌 Доступні ендпоінти</div>
    <div class="endpoints-info">
      <code>POST /v1/chat/completions</code> — чат, reasoning, стрімінг<br>
      <code>POST /v1/embeddings</code> — текстові ембединги<br>
      <code>POST /v1/images/generations</code> — генерація зображень<br>
      <code>POST /v1/audio/transcriptions</code> — STT (multipart/form-data)<br>
      <code>POST /v1/audio/translations</code> — переклад аудіо<br>
      <code>POST /v1/audio/speech</code> — TTS (→ аудіо файл)<br>
      <code>POST /v1/completions</code> — legacy text completion<br>
      <code>GET &nbsp;/v1/models</code> — список моделей<br>
      <code>ANY &nbsp;/v1/*</code> — будь-який інший NIM ендпоінт (pass-through)
    </div>
  </div>

  ${ADMIN_KEY ? `<div id="keyWrap"><input id="keyInput" type="password" placeholder="🔑 Ключ адміна..."></div>` : ''}

  <div class="card">
    <div class="card-title">🧠 Мислення (для chat)</div>
    <div class="row">
      <div><div class="lbl">Режим мислення</div><div class="desc">extra_body thinking: true</div></div>
      <label class="toggle"><input type="checkbox" id="enableThinking"><span class="sl"></span></label>
    </div>
    <div class="row">
      <div><div class="lbl">Показувати &lt;think&gt;</div><div class="desc">Включати reasoning у відповідь</div></div>
      <label class="toggle"><input type="checkbox" id="showReasoning"><span class="sl"></span></label>
    </div>
  </div>

  <div class="card">
    <div class="card-title">🔁 Retry при 429</div>
    <div class="row">
      <div><div class="lbl">Кількість спроб</div></div>
      <input class="num" type="number" id="max429Retries" min="0" max="10">
    </div>
    <div class="row">
      <div><div class="lbl">Пауза (мс)</div></div>
      <input class="num" type="number" id="retry429DelayMs" min="500" step="500">
    </div>
  </div>

  <div class="card">
    <div class="card-title">🔁 Retry при 5xx</div>
    <div class="row">
      <div><div class="lbl">Кількість спроб</div></div>
      <input class="num" type="number" id="maxRetries" min="0" max="5">
    </div>
    <div class="row">
      <div><div class="lbl">Пауза (мс)</div></div>
      <input class="num" type="number" id="retryDelayMs" min="100" step="100">
    </div>
  </div>

  <div class="card">
    <div class="card-title">🎛️ Дефолти</div>
    <div class="row">
      <div><div class="lbl">Температура</div></div>
      <input class="num" type="number" id="defaultTemperature" min="0" max="2" step="0.05">
    </div>
    <div class="row">
      <div><div class="lbl">Макс. токени</div></div>
      <input class="num" type="number" id="defaultMaxTokens" min="256" step="256">
    </div>
    <div class="row">
      <div><div class="lbl">Таймаут (мс)</div></div>
      <input class="num" type="number" id="timeoutMs" min="10000" step="5000">
    </div>
  </div>

  <button class="btn" onclick="save()">💾 Зберегти</button>
  <div id="status"></div>

  <script>
    const $ = id => document.getElementById(id);
    function fmtUptime(ms) {
      const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
      if(d>0) return d+'д '+(h%24)+'г';
      if(h>0) return h+'г '+(m%60)+'хв';
      if(m>0) return m+'хв '+(s%60)+'с';
      return s+'с';
    }
    async function loadStats() {
      try {
        const s = await fetch('/admin/stats').then(r=>r.json());
        $('sTotal').textContent = s.total;
        $('sSuccess').textContent = s.success;
        $('s429').textContent = s.err429;
        $('s5xx').textContent = s.err5xx;
        $('uptimeEl').textContent = 'Аптайм: ' + fmtUptime(s.uptimeMs);
        const ep = s.byEndpoint ?? {};
        const keys = Object.keys(ep);
        if (keys.length) {
          $('epGrid').innerHTML = keys.sort((a,b)=>ep[b]-ep[a]).map(k =>
            \`<div class="ep-name">\${k}</div><div class="ep-cnt">\${ep[k]}</div>\`
          ).join('');
        }
      } catch {}
    }
    async function load() {
      try {
        const c = await fetch('/admin/config').then(r=>r.json());
        $('enableThinking').checked = c.enableThinking;
        $('showReasoning').checked = c.showReasoning;
        $('maxRetries').value = c.maxRetries;
        $('retryDelayMs').value = c.retryDelayMs;
        $('max429Retries').value = c.max429Retries;
        $('retry429DelayMs').value = c.retry429DelayMs;
        $('defaultTemperature').value = c.defaultTemperature;
        $('defaultMaxTokens').value = c.defaultMaxTokens;
        $('timeoutMs').value = c.timeoutMs;
      } catch { $('status').innerHTML = '<span class="errt">Не вдалося завантажити</span>'; }
    }
    async function save() {
      const body = {
        enableThinking: $('enableThinking').checked,
        showReasoning: $('showReasoning').checked,
        maxRetries: +$('maxRetries').value,
        retryDelayMs: +$('retryDelayMs').value,
        max429Retries: +$('max429Retries').value,
        retry429DelayMs: +$('retry429DelayMs').value,
        defaultTemperature: +$('defaultTemperature').value,
        defaultMaxTokens: +$('defaultMaxTokens').value,
        timeoutMs: +$('timeoutMs').value,
      };
      const headers = {'Content-Type':'application/json'};
      const ki = $('keyInput');
      if (ki) headers['x-admin-key'] = ki.value;
      try {
        const r = await fetch('/admin/config', {method:'POST', headers, body: JSON.stringify(body)});
        if (r.ok) {
          $('status').innerHTML = '<span class="ok">✓ Збережено</span>';
          setTimeout(()=>$('status').innerHTML='', 2500);
        } else {
          const e = await r.json();
          $('status').innerHTML = '<span class="errt">'+(e.error||'Помилка')+'</span>';
        }
      } catch { $('status').innerHTML = '<span class="errt">Помилка мережі</span>'; }
    }
    load(); loadStats();
    setInterval(loadStats, 10000);
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Date.now() - stats.startTime }));
app.get('/admin', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(buildAdminHtml()); });
app.get('/admin/config', (req, res) => res.json(config));
app.get('/admin/stats', (req, res) => res.json({ ...stats, uptimeMs: Date.now() - stats.startTime }));

app.post('/admin/config', (req, res) => {
  if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Невірний ключ' });
  for (const [key, val] of Object.entries(req.body)) {
    if (!(key in config)) continue;
    config[key] = typeof config[key] === 'boolean' ? Boolean(val) : Number(val);
  }
  console.log('Config оновлено:', config);
  res.json({ success: true, config });
});

// ─── GET /v1/models ─────────────────────────────────────────────────────────
app.get('/v1/models', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  trackEndpoint('GET /v1/models');
  try {
    const response = await fetchWithRetry({
      method: 'get',
      url: `${NIM_API_BASE}/models`,
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: config.timeoutMs,
    });
    res.json(response.data);
  } catch (err) {
    // Fallback якщо NIM не підтримує /models
    res.json({ object: 'list', data: [{ id: 'nvidia-nim-proxy', object: 'model', created: Date.now(), owned_by: 'nvidia' }] });
  }
});

// ─── POST /v1/chat/completions ───────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });

  let { model, messages, temperature, max_tokens, stream } = req.body;
  if (!model || !messages) return res.status(400).json({ error: { message: 'model і messages обовязкові', code: 400 } });

  // Санітизація повідомлень (Mistral/JanitorAI сумісність)
  let sanitizedMessages = [];
  let systemContent = '';
  for (const msg of messages) {
    const cleanMsg = { role: msg.role, content: msg.content ?? '' };
    if (cleanMsg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + cleanMsg.content;
    } else {
      const last = sanitizedMessages[sanitizedMessages.length - 1];
      if (last && last.role === cleanMsg.role) last.content += '\n\n' + cleanMsg.content;
      else sanitizedMessages.push(cleanMsg);
    }
  }
  if (systemContent) sanitizedMessages.unshift({ role: 'system', content: systemContent });
  messages = sanitizedMessages;

  stats.total++;
  trackEndpoint('POST /v1/chat/completions');

  const nimBody = {
    model, messages,
    temperature: temperature ?? config.defaultTemperature,
    max_tokens: max_tokens ?? config.defaultMaxTokens,
    stream: stream ?? false,
    ...(config.enableThinking && { extra_body: { chat_template_kwargs: { thinking: true } } }),
  };

  // Прокидуємо решту полів із req.body (top_p, stop, etc.)
  const knownFields = new Set(['model','messages','temperature','max_tokens','stream']);
  for (const [k, v] of Object.entries(req.body)) {
    if (!knownFields.has(k)) nimBody[k] = v;
  }

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      data: nimBody,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json',
      timeout: config.timeoutMs,
    });

    stats.success++;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '', inReasoning = false;
      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (t === 'data: [DONE]') { res.write('data: [DONE]\n\n'); continue; }
          if (!t.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(t.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (delta) {
              const rc = delta.reasoning_content, c = delta.content;
              if (config.showReasoning) {
                let out = '';
                if (rc && !inReasoning) { out = '<think>\n' + rc; inReasoning = true; }
                else if (rc) out = rc;
                if (c && inReasoning) { out += '\n</think>\n\n' + c; inReasoning = false; }
                else if (c) out += c;
                delta.content = out || '';
              } else {
                if (rc && !c) continue;
                delta.content = c ?? '';
              }
              delete delta.reasoning_content;
            }
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {}
        }
      });
      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      const data = response.data;
      for (const choice of data.choices ?? []) {
        const msg = choice.message;
        if (!msg) continue;
        if (config.showReasoning && msg.reasoning_content)
          msg.content = `<think>\n${msg.reasoning_content}\n</think>\n\n${msg.content ?? ''}`;
        delete msg.reasoning_content;
      }
      res.json(data);
    }
  } catch (err) { handleError(err, res); }
});

// ─── POST /v1/completions (legacy) ──────────────────────────────────────────
app.post('/v1/completions', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });

  stats.total++;
  trackEndpoint('POST /v1/completions');

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/completions`,
      data: req.body,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: req.body.stream ? 'stream' : 'json',
      timeout: config.timeoutMs,
    });
    stats.success++;
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }
  } catch (err) { handleError(err, res); }
});

// ─── POST /v1/embeddings ─────────────────────────────────────────────────────
app.post('/v1/embeddings', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  if (!req.body.model || req.body.input === undefined)
    return res.status(400).json({ error: { message: 'model і input обовязкові', code: 400 } });

  stats.total++;
  trackEndpoint('POST /v1/embeddings');

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/embeddings`,
      data: req.body,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: config.timeoutMs,
    });
    stats.success++;
    res.json(response.data);
  } catch (err) { handleError(err, res); }
});

// ─── POST /v1/images/generations ─────────────────────────────────────────────
app.post('/v1/images/generations', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  if (!req.body.model || !req.body.prompt)
    return res.status(400).json({ error: { message: 'model і prompt обовязкові', code: 400 } });

  stats.total++;
  trackEndpoint('POST /v1/images/generations');

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/images/generations`,
      data: req.body,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: config.timeoutMs,
    });
    stats.success++;
    res.json(response.data);
  } catch (err) { handleError(err, res); }
});

// ─── POST /v1/audio/transcriptions (STT) ─────────────────────────────────────
// Приймає multipart/form-data з полем "file"
app.post('/v1/audio/transcriptions', upload.single('file'), async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  if (!req.file) return res.status(400).json({ error: { message: 'Файл аудіо обовязковий (поле "file")', code: 400 } });
  if (!req.body.model) return res.status(400).json({ error: { message: 'model обовязкова', code: 400 } });

  stats.total++;
  trackEndpoint('POST /v1/audio/transcriptions');

  const form = new FormData();
  form.append('file', req.file.buffer, {
    filename: req.file.originalname || 'audio.wav',
    contentType: req.file.mimetype,
  });
  form.append('model', req.body.model);
  if (req.body.language) form.append('language', req.body.language);
  if (req.body.response_format) form.append('response_format', req.body.response_format);
  if (req.body.temperature) form.append('temperature', req.body.temperature);

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/audio/transcriptions`,
      data: form,
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: config.timeoutMs,
    });
    stats.success++;
    res.json(response.data);
  } catch (err) { handleError(err, res); }
});

// ─── POST /v1/audio/translations ─────────────────────────────────────────────
app.post('/v1/audio/translations', upload.single('file'), async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  if (!req.file) return res.status(400).json({ error: { message: 'Файл аудіо обовязковий', code: 400 } });

  stats.total++;
  trackEndpoint('POST /v1/audio/translations');

  const form = new FormData();
  form.append('file', req.file.buffer, { filename: req.file.originalname || 'audio.wav', contentType: req.file.mimetype });
  if (req.body.model) form.append('model', req.body.model);
  if (req.body.response_format) form.append('response_format', req.body.response_format);

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/audio/translations`,
      data: form,
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
      timeout: config.timeoutMs,
    });
    stats.success++;
    res.json(response.data);
  } catch (err) { handleError(err, res); }
});

// ─── POST /v1/audio/speech (TTS) ─────────────────────────────────────────────
// Повертає аудіо файл (binary stream)
app.post('/v1/audio/speech', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  if (!req.body.model || !req.body.input)
    return res.status(400).json({ error: { message: 'model і input обовязкові', code: 400 } });

  stats.total++;
  trackEndpoint('POST /v1/audio/speech');

  try {
    const response = await fetchWithRetry({
      method: 'post',
      url: `${NIM_API_BASE}/audio/speech`,
      data: req.body,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: 'stream',
      timeout: config.timeoutMs,
    });
    stats.success++;
    // Прокидуємо Content-Type від NIM (mp3, wav, opus, etc.)
    const ct = response.headers['content-type'] ?? 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    if (response.headers['content-disposition'])
      res.setHeader('Content-Disposition', response.headers['content-disposition']);
    response.data.pipe(res);
  } catch (err) { handleError(err, res); }
});

// ─── UNIVERSAL PASS-THROUGH для /v1/* ────────────────────────────────────────
// Це покриє Drug Discovery, Object Detection, OCR, Digital Twin, і все інше
// що має JSON тіло або query params. Файли НЕ підтримуються тут — тільки JSON.
app.all('/v1/*', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });

  const nimPath = req.path; // вже /v1/...
  const isStream = req.body?.stream === true;
  const endpoint = `${req.method} ${nimPath}`;

  stats.total++;
  trackEndpoint(endpoint);
  console.log(`[pass-through] ${endpoint}`);

  try {
    const response = await fetchWithRetry({
      method: req.method.toLowerCase(),
      url: `${NIM_API_BASE}${nimPath}`,
      data: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      params: req.query,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: isStream ? 'stream' : 'json',
      timeout: config.timeoutMs,
    });

    stats.success++;

    if (isStream) {
      res.setHeader('Content-Type', response.headers['content-type'] ?? 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      response.data.pipe(res);
    } else {
      // Копіюємо важливі заголовки відповіді
      const ct = response.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      res.status(response.status).json(response.data);
    }
  } catch (err) { handleError(err, res); }
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.all('*', (req, res) => res.status(404).json({
  error: { message: `Ендпоінт ${req.path} не знайдено. Всі NIM ендпоінти доступні через /v1/*` }
}));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('SIGTERM отримано, завершую...');
  setTimeout(() => process.exit(0), 3000);
});

app.listen(PORT, () => console.log(`✅ NIM Universal Proxy на порту ${PORT} | /admin для налаштувань`));

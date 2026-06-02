const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// 50mb для гігантських лорбуків і довгих RP чатів
app.use(express.json({ limit: '50mb' })); 

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';

// Глобальний агент для Keep-Alive (зменшує затримку підключення)
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// ─── Живий конфіг ──────────────────────────────────────────────────────────
const config = {
  showReasoning:      process.env.SHOW_REASONING === 'true',
  enableThinking:     process.env.ENABLE_THINKING === 'true',
  maxRetries:         parseInt(process.env.MAX_RETRIES ?? '2'),
  retryDelayMs:       parseInt(process.env.RETRY_DELAY_MS ?? '1000'),
  max429Retries:      parseInt(process.env.MAX_429_RETRIES ?? '3'),
  retry429DelayMs:    parseInt(process.env.RETRY_429_DELAY_MS ?? '5000'),
  defaultTemperature: parseFloat(process.env.DEFAULT_TEMPERATURE ?? '0.8'),
  defaultMaxTokens:   parseInt(process.env.DEFAULT_MAX_TOKENS ?? '4096'),
  timeoutMs:          parseInt(process.env.TIMEOUT_MS ?? '120000'),
};

const stats = { total: 0, success: 0, err429: 0, err5xx: 0, errOther: 0, startTime: Date.now() };

// Пам'ять проксі: моделі, які точно не розуміють thinking
const unsupportedThinkingModels = new Set();

// ─── Retry логіка + Каскадний Fallback (Розумний фільтр) ───────────────────
async function fetchWithRetry(initialData, reqConfig) {
  let attempts5xx = 0;
  let attempts429 = 0;
  let fallbackLevel = 0; // 0 = оригінал, 1 = без thinking, 2 = тільки базові параметри
  
  let currentData = { ...initialData };

  while (true) {
    try {
      return await axiosInstance({ ...reqConfig, data: currentData });
    } catch (err) {
      const status = err.response?.status;
      const errMsg = (err.response?.data?.detail ?? err.response?.data?.error?.message ?? '').toLowerCase();

      // --- 400 Каскадний Fallback ---
      // Якщо помилка пов'язана з токенами (context length), ми НЕ робимо fallback, бо це не допоможе.
      const isContextError = errMsg.includes('token') || errMsg.includes('context') || errMsg.includes('length');

      if (status === 400 && fallbackLevel < 2 && !isContextError) {
        fallbackLevel++;
        if (fallbackLevel === 1) {
          console.log(`[Fallback 1] Модель ${currentData.model} ймовірно не підтримує extra_body. Видаляємо...`);
          unsupportedThinkingModels.add(currentData.model);
          delete currentData.extra_body;
          continue; // Миттєва повторна спроба
        }
        if (fallbackLevel === 2) {
          console.log(`[Fallback 2] Модель ${currentData.model} не розуміє RP параметри. Залишаємо тільки базу.`);
          const safeData = {
            model: currentData.model,
            messages: currentData.messages,
            temperature: currentData.temperature,
            max_tokens: currentData.max_tokens,
            stream: currentData.stream,
            top_p: currentData.top_p,
            stop: currentData.stop
          };
          currentData = safeData;
          continue; // Миттєва повторна спроба
        }
      }

      // --- 429 Rate Limit ---
      if (status === 429 && attempts429 < config.max429Retries) {
        attempts429++;
        stats.err429++;
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] ?? '0') * 1000;
        const delay = retryAfter > 0 ? retryAfter : config.retry429DelayMs;
        console.log(`[429] Retry ${attempts429}/${config.max429Retries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // --- 5xx Server Errors ---
      if (status >= 500 && attempts5xx < config.maxRetries) {
        attempts5xx++;
        stats.err5xx++;
        const delay = config.retryDelayMs * Math.pow(2, attempts5xx - 1);
        console.log(`[${status}] Retry ${attempts5xx}/${config.maxRetries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw err; // Прокидаємо помилку далі, якщо ретраї скінчились або помилка критична
    }
  }
}

// ─── Повний Адмін HTML ─────────────────────────────────────────────────────
function buildAdminHtml() {
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NIM RP Proxy</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f13;color:#e0e0e0;font-family:-apple-system,sans-serif;padding:16px;max-width:480px;margin:0 auto;padding-bottom:32px}
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
    .lbl{font-size:15px}
    .desc{font-size:12px;color:#555;margin-top:2px}
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
    #keyInput::placeholder{color:#444}
    .btn{width:100%;padding:14px;background:#76b900;border:none;border-radius:12px;color:#000;font-size:16px;font-weight:700;cursor:pointer;transition:.1s}
    .btn:active{opacity:.85}
    #status{text-align:center;margin-top:12px;font-size:14px;min-height:20px}
    .ok{color:#76b900}.err{color:#ff4455}
    .uptime{font-size:11px;color:#444;text-align:center;margin-bottom:16px}
  </style>
</head>
<body>
  <h1>⚙️ NIM RP Proxy</h1>
  <p class="sub">Зміни живі — без перезапуску</p>

  <div class="stats" id="statsGrid">
    <div class="stat"><div class="stat-val" id="sTotal">—</div><div class="stat-lbl">Всього запитів</div></div>
    <div class="stat"><div class="stat-val" id="sSuccess">—</div><div class="stat-lbl">Успішних</div></div>
    <div class="stat warn"><div class="stat-val" id="s429">—</div><div class="stat-lbl">429 (rate limit)</div></div>
    <div class="stat err"><div class="stat-val" id="s5xx">—</div><div class="stat-lbl">5xx помилки</div></div>
  </div>
  <div class="uptime" id="uptimeEl"></div>

  ${ADMIN_KEY ? `<div id="keyWrap">
    <input id="keyInput" type="password" placeholder="🔑 Ключ адміна...">
  </div>` : '<div style="color:#ffaa00; font-size:12px; margin-bottom:16px; text-align:center">⚠️ ADMIN_KEY не задано. Збереження недоступне.</div>'}

  <div class="card">
    <div class="card-title">🧠 Мислення</div>
    <div class="row">
      <div><div class="lbl">Режим мислення</div><div class="desc">Надсилати thinking в NIM</div></div>
      <label class="toggle"><input type="checkbox" id="enableThinking"><span class="sl"></span></label>
    </div>
    <div class="row">
      <div><div class="lbl">Показувати мислення</div><div class="desc">Включати &lt;think&gt; у відповідь</div></div>
      <label class="toggle"><input type="checkbox" id="showReasoning"><span class="sl"></span></label>
    </div>
  </div>

  <div class="card">
    <div class="card-title">🔁 Retry при 429 (rate limit)</div>
    <div class="row">
      <div><div class="lbl">Кількість спроб</div><div class="desc">0 = не повторювати</div></div>
      <input class="num" type="number" id="max429Retries" min="0" max="10">
    </div>
    <div class="row">
      <div><div class="lbl">Пауза (мс)</div><div class="desc">Якщо NIM не вказав Retry-After</div></div>
      <input class="num" type="number" id="retry429DelayMs" min="500" step="500">
    </div>
  </div>

  <div class="card">
    <div class="card-title">🔁 Retry при 5xx (помилка сервера)</div>
    <div class="row">
      <div><div class="lbl">Кількість спроб</div><div class="desc">0 = не повторювати</div></div>
      <input class="num" type="number" id="maxRetries" min="0" max="5">
    </div>
    <div class="row">
      <div><div class="lbl">Пауза (мс)</div><div class="desc">Початкова, подвоюється</div></div>
      <input class="num" type="number" id="retryDelayMs" min="100" step="100">
    </div>
  </div>

  <div class="card">
    <div class="card-title">🎛️ Дефолти (RP Клієнт пріоритетніший)</div>
    <div class="row">
      <div><div class="lbl">Температура</div></div>
      <input class="num" type="number" id="defaultTemperature" min="0" max="2" step="0.05">
    </div>
    <div class="row">
      <div><div class="lbl">Макс. токени</div></div>
      <input class="num" type="number" id="defaultMaxTokens" min="256" step="256">
    </div>
    <div class="row">
      <div><div class="lbl">Таймаут (мс)</div><div class="desc">Тільки для не-стрімових</div></div>
      <input class="num" type="number" id="timeoutMs" min="10000" step="5000">
    </div>
  </div>

  <button class="btn" onclick="save()">💾 Зберегти</button>
  <div id="status"></div>

  <script>
    const $ = id => document.getElementById(id);
    const statusEl = $('status');

    function fmtUptime(ms) {
      const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
      if (d > 0) return d + 'д ' + (h%24) + 'г';
      if (h > 0) return h + 'г ' + (m%60) + 'хв';
      if (m > 0) return m + 'хв ' + (s%60) + 'с';
      return s + 'с';
    }

    async function loadStats() {
      try {
        const s = await fetch('/admin/stats').then(r => r.json());
        $('sTotal').textContent = s.total;
        $('sSuccess').textContent = s.success;
        $('s429').textContent = s.err429;
        $('s5xx').textContent = s.err5xx;
        $('uptimeEl').textContent = 'Аптайм: ' + fmtUptime(s.uptimeMs);
      } catch {}
    }

    async function load() {
      try {
        const c = await fetch('/admin/config').then(r => r.json());
        $('enableThinking').checked  = c.enableThinking;
        $('showReasoning').checked   = c.showReasoning;
        $('maxRetries').value        = c.maxRetries;
        $('retryDelayMs').value      = c.retryDelayMs;
        $('max429Retries').value     = c.max429Retries;
        $('retry429DelayMs').value   = c.retry429DelayMs;
        $('defaultTemperature').value = c.defaultTemperature;
        $('defaultMaxTokens').value  = c.defaultMaxTokens;
        $('timeoutMs').value         = c.timeoutMs;
      } catch { statusEl.innerHTML = '<span class="err">Не вдалося завантажити конфіг</span>'; }
    }

    async function save() {
      const body = {
        enableThinking:     $('enableThinking').checked,
        showReasoning:      $('showReasoning').checked,
        maxRetries:         +$('maxRetries').value,
        retryDelayMs:       +$('retryDelayMs').value,
        max429Retries:      +$('max429Retries').value,
        retry429DelayMs:    +$('retry429DelayMs').value,
        defaultTemperature: +$('defaultTemperature').value,
        defaultMaxTokens:   +$('defaultMaxTokens').value,
        timeoutMs:          +$('timeoutMs').value,
      };
      const headers = { 'Content-Type': 'application/json' };
      const ki = $('keyInput');
      if (ki) headers['x-admin-key'] = ki.value;
      
      try {
        const r = await fetch('/admin/config', { method: 'POST', headers, body: JSON.stringify(body) });
        if (r.ok) {
          statusEl.innerHTML = '<span class="ok">✓ Збережено</span>';
          setTimeout(() => statusEl.innerHTML = '', 2500);
        } else {
          const e = await r.json();
          statusEl.innerHTML = '<span class="err">' + (e.error || 'Помилка доступу') + '</span>';
        }
      } catch { statusEl.innerHTML = '<span class="err">Помилка мережі</span>'; }
    }

    load();
    loadStats();
    setInterval(loadStats, 10000);
  </script>
</body>
</html>`;
}

// ─── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildAdminHtml());
});

// Захист всіх /admin API маршрутів
app.use('/admin/*', (req, res, next) => {
  if (!ADMIN_KEY) return res.status(403).json({ error: 'Адмін-панель заблокована. Встановіть ADMIN_KEY.' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Невірний ключ' });
  next();
});

app.get('/admin/config', (req, res) => res.json(config));
app.get('/admin/stats', (req, res) => res.json({ ...stats, uptimeMs: Date.now() - stats.startTime }));
app.post('/admin/config', (req, res) => {
  for (const [key, val] of Object.entries(req.body)) {
    if (key in config) config[key] = typeof config[key] === 'boolean' ? Boolean(val) : Number(val);
  }
  res.json({ success: true, config });
});

app.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: [{ id: 'nvidia-nim-rp-proxy', object: 'model', created: Date.now(), owned_by: 'nvidia' }] });
});

// ─── Main proxy ─────────────────────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  const authHeader = req.headers['authorization'] ?? '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });

  const { model, messages } = req.body;
  if (!model || !messages) return res.status(400).json({ error: { message: 'model і messages обовязкові', code: 400 } });

  stats.total++;

  // КЛІЄНТ — БОС: прокидаємо всі його параметри (top_k, min_p, stream_options тощо).
  const nimBody = {
    temperature: config.defaultTemperature,
    max_tokens: config.defaultMaxTokens,
    ...req.body,
  };

  // Розумне додавання мислення (тільки якщо модель ще не відхилила це раніше)
  if (config.enableThinking && !unsupportedThinkingModels.has(model)) {
    nimBody.extra_body = { ...(nimBody.extra_body || {}), chat_template_kwargs: { thinking: true } };
  }

  try {
    const response = await fetchWithRetry(nimBody, {
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: nimBody.stream ? 'stream' : 'json',
      // У стрімінгу вимикаємо таймаут Axios, щоб не обривати довгі роздуми
      timeout: nimBody.stream ? 0 : config.timeoutMs, 
    });

    stats.success++;

    if (nimBody.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Graceful shutdown & Client Abort Protection
      const onClientClose = () => { response.data.destroy(); };
      req.on('close', onClientClose);

      const onAppTerminate = () => { response.data.destroy(); res.end(); };
      process.once('SIGTERM', onAppTerminate);

      // Декодер для кирилиці та емодзі
      const decoder = new TextDecoder('utf-8');
      let buffer = '', inReasoning = false;

      response.data.on('data', chunk => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Зберігаємо неповний рядок для наступного чанку

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
                if (rc && !c) continue; // Ховаємо роздуми
                delta.content = c ?? '';
              }
              delete delta.reasoning_content;
            }
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {}
        }
      });

      response.data.on('end', () => { 
        process.off('SIGTERM', onAppTerminate); 
        res.end(); 
      });
      response.data.on('error', () => { 
        process.off('SIGTERM', onAppTerminate); 
        res.end(); 
      });

    } else {
      const data = response.data;
      for (const choice of data.choices ?? []) {
        const msg = choice.message;
        if (!msg) continue;
        if (config.showReasoning && msg.reasoning_content) {
          msg.content = `<think>\n${msg.reasoning_content}\n</think>\n\n${msg.content ?? ''}`;
        }
        delete msg.reasoning_content;
      }
      res.json(data);
    }

  } catch (err) {
    if (res.headersSent) {
      return res.end(); // Якщо помилка під час стріму, закриваємо його тихо
    }
    const status = err.response?.status ?? 500;
    const message = err.response?.data?.detail ?? err.response?.data?.error?.message ?? err.message ?? 'Невідома помилка';
    if (status !== 429 && status < 500) stats.errOther++;
    console.error(`[${status}] ${JSON.stringify(message)}`);
    res.status(status).json({ error: { message, code: status } });
  }
});

// 404 обробник
app.all('*', (req, res) => res.status(404).json({ error: { message: `Ендпоінт ${req.path} не знайдено` } }));

// ─── Graceful shutdown ─────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('SIGTERM отримано, завершую...');
  setTimeout(() => process.exit(0), 3000);
});

app.listen(PORT, () => console.log(`✅ RP-Проксі на порту ${PORT} | /admin для налаштувань`));
    

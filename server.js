const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); 

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// ─── Генеративний Адмін-Ключ ───────────────────────────────────────────────
let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  ADMIN_KEY = crypto.randomBytes(6).toString('hex');
  console.log('\n=============================================================');
  console.log('⚠️ Змінну ADMIN_KEY не задано в середовищі (Environment)!');
  console.log(`🔑 Згенеровано тимчасовий адмін-ключ для цієї сесії: ${ADMIN_KEY}`);
  console.log('=============================================================\n');
}

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
const unsupportedThinkingModels = new Set();

// ─── Retry логіка + Каскадний Fallback (3 рівні) ───────────────────────────
async function fetchWithRetry(initialData, reqConfig) {
  let attempts5xx = 0;
  let attempts429 = 0;
  let fallbackLevel = 0; 
  let currentData = { ...initialData };

  while (true) {
    try {
      return await axiosInstance({ ...reqConfig, data: currentData });
    } catch (err) {
      const status = err.response?.status;
      const errorData = err.response?.data || {};
      
      // Намагаємось витягти точну причину помилки від NIM
      let exactReason = '';
      if (typeof errorData.detail === 'string') exactReason = errorData.detail.toLowerCase();
      else if (errorData.detail) exactReason = JSON.stringify(errorData.detail).toLowerCase();
      else if (errorData.error?.message) exactReason = errorData.error.message.toLowerCase();

      const isContextError = exactReason.includes('token') || exactReason.includes('context') || exactReason.includes('length');

      // --- 400 Каскадний Fallback ---
      if (status === 400 && fallbackLevel < 3 && !isContextError) {
        fallbackLevel++;
        if (fallbackLevel === 1) {
          console.log(`[Fallback 1] ${currentData.model} - видаляємо extra_body...`);
          unsupportedThinkingModels.add(currentData.model);
          delete currentData.extra_body;
          continue;
        }
        if (fallbackLevel === 2) {
          console.log(`[Fallback 2] ${currentData.model} - залишаємо тільки базові параметри...`);
          currentData = {
            model: currentData.model,
            messages: currentData.messages,
            temperature: currentData.temperature,
            max_tokens: currentData.max_tokens,
            stream: currentData.stream,
            top_p: currentData.top_p
          };
          continue;
        }
        if (fallbackLevel === 3) {
          console.log(`[Fallback 3] ${currentData.model} - ГОЛИЙ ЗАПИТ. Відкидаємо абсолютно все, крім messages.`);
          // Mistral та інші примхливі моделі іноді не сприймають навіть дефолтні max_tokens від клієнта
          currentData = {
            model: currentData.model,
            messages: currentData.messages,
            stream: currentData.stream
          };
          continue;
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

      // Якщо ретраї скінчились, прокидаємо розширену помилку для логів RP клієнта
      throw err;
    }
  }
}

// ─── Адмін HTML ─────────────────────────────────────────────────────────────
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
    .card{background:#1a1a24;border-radius:14px;padding:16px;margin-bottom:12px;opacity:0.4;pointer-events:none;transition:0.3s}
    .card.unlocked{opacity:1;pointer-events:auto}
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
    .auth-box{display:flex;gap:8px;margin-bottom:16px}
    #keyInput{flex:1;background:#22222f;border:1px solid #2e2e40;color:#fff;padding:12px;border-radius:10px;font-size:15px}
    .btn-auth{padding:0 20px;background:#333344;border:none;border-radius:10px;color:#fff;font-weight:600;cursor:pointer}
    .btn-auth:active{background:#445}
    .btn{width:100%;padding:14px;background:#76b900;border:none;border-radius:12px;color:#000;font-size:16px;font-weight:700;cursor:pointer;opacity:0.4;pointer-events:none}
    .btn.unlocked{opacity:1;pointer-events:auto}
    #status{text-align:center;margin-top:12px;font-size:14px;min-height:20px}
    .ok{color:#76b900}.err{color:#ff4455}
    .uptime{font-size:11px;color:#444;text-align:center;margin-bottom:16px}
  </style>
</head>
<body>
  <h1>⚙️ NIM RP Proxy</h1>
  <p class="sub">Панель керування</p>

  <div class="auth-box">
    <input id="keyInput" type="password" placeholder="🔑 Ключ адміна...">
    <button class="btn-auth" onclick="login()">Увійти</button>
  </div>
  <div id="status"></div>

  <div class="stats" id="statsGrid">
    <div class="stat"><div class="stat-val" id="sTotal">—</div><div class="stat-lbl">Запитів</div></div>
    <div class="stat"><div class="stat-val" id="sSuccess">—</div><div class="stat-lbl">Успішних</div></div>
    <div class="stat warn"><div class="stat-val" id="s429">—</div><div class="stat-lbl">429 Errors</div></div>
    <div class="stat err"><div class="stat-val" id="s5xx">—</div><div class="stat-lbl">5xx Errors</div></div>
  </div>
  <div class="uptime" id="uptimeEl"></div>

  <div class="card" id="c1">
    <div class="card-title">🧠 Мислення</div>
    <div class="row">
      <div><div class="lbl">Режим мислення</div></div>
      <label class="toggle"><input type="checkbox" id="enableThinking"><span class="sl"></span></label>
    </div>
    <div class="row">
      <div><div class="lbl">Показувати &lt;think&gt;</div></div>
      <label class="toggle"><input type="checkbox" id="showReasoning"><span class="sl"></span></label>
    </div>
  </div>

  <div class="card" id="c2">
    <div class="card-title">🔁 Retry налаштування</div>
    <div class="row"><div><div class="lbl">Спроби при 429</div></div><input class="num" type="number" id="max429Retries"></div>
    <div class="row"><div><div class="lbl">Спроби при 5xx</div></div><input class="num" type="number" id="maxRetries"></div>
  </div>

  <div class="card" id="c3">
    <div class="card-title">🎛️ Дефолти</div>
    <div class="row"><div><div class="lbl">Температура</div></div><input class="num" type="number" id="defaultTemperature" step="0.1"></div>
    <div class="row"><div><div class="lbl">Макс. токени</div></div><input class="num" type="number" id="defaultMaxTokens"></div>
  </div>

  <button class="btn" id="saveBtn" onclick="save()">💾 Зберегти конфіг</button>

  <script>
    const $ = id => document.getElementById(id);
    const statusEl = $('status');
    let refreshInterval = null;

    // Відновлюємо ключ з пам'яті
    window.onload = () => {
      const saved = localStorage.getItem('nim_key');
      if (saved) { $('keyInput').value = saved; login(); }
    };

    function unlockUI() {
      $('c1').classList.add('unlocked');
      $('c2').classList.add('unlocked');
      $('c3').classList.add('unlocked');
      $('saveBtn').classList.add('unlocked');
    }

    async function login() {
      const key = $('keyInput').value.trim();
      if (!key) return;
      
      try {
        const r = await fetch('/admin/config', { headers: { 'x-admin-key': key } });
        if (r.ok) {
          localStorage.setItem('nim_key', key);
          statusEl.innerHTML = '<span class="ok">✓ Авторизовано</span>';
          unlockUI();
          
          const c = await r.json();
          $('enableThinking').checked  = c.enableThinking;
          $('showReasoning').checked   = c.showReasoning;
          $('maxRetries').value        = c.maxRetries;
          $('max429Retries').value     = c.max429Retries;
          $('defaultTemperature').value = c.defaultTemperature;
          $('defaultMaxTokens').value  = c.defaultMaxTokens;

          loadStats();
          if(refreshInterval) clearInterval(refreshInterval);
          refreshInterval = setInterval(loadStats, 5000);
          setTimeout(() => statusEl.innerHTML='', 2000);
        } else {
          statusEl.innerHTML = '<span class="err">❌ Невірний ключ</span>';
        }
      } catch { statusEl.innerHTML = '<span class="err">Помилка мережі</span>'; }
    }

    async function loadStats() {
      const key = localStorage.getItem('nim_key');
      if (!key) return;
      try {
        const s = await fetch('/admin/stats', { headers: { 'x-admin-key': key } }).then(r => r.json());
        $('sTotal').textContent = s.total;
        $('sSuccess').textContent = s.success;
        $('s429').textContent = s.err429;
        $('s5xx').textContent = s.err5xx;
        $('uptimeEl').textContent = 'Аптайм: ' + Math.floor(s.uptimeMs/60000) + ' хв';
      } catch {}
    }

    async function save() {
      const key = localStorage.getItem('nim_key');
      const body = {
        enableThinking:     $('enableThinking').checked,
        showReasoning:      $('showReasoning').checked,
        maxRetries:         +$('maxRetries').value,
        max429Retries:      +$('max429Retries').value,
        defaultTemperature: +$('defaultTemperature').value,
        defaultMaxTokens:   +$('defaultMaxTokens').value,
      };
      
      try {
        const r = await fetch('/admin/config', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, 
          body: JSON.stringify(body) 
        });
        if (r.ok) {
          statusEl.innerHTML = '<span class="ok">✓ Збережено</span>';
          setTimeout(() => statusEl.innerHTML = '', 2000);
        } else {
          statusEl.innerHTML = '<span class="err">Помилка доступу</span>';
        }
      } catch { statusEl.innerHTML = '<span class="err">Помилка мережі</span>'; }
    }
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

app.use('/admin/*', (req, res, next) => {
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

  const nimBody = {
    temperature: config.defaultTemperature,
    max_tokens: config.defaultMaxTokens,
    ...req.body,
  };

  if (config.enableThinking && !unsupportedThinkingModels.has(model)) {
    nimBody.extra_body = { ...(nimBody.extra_body || {}), chat_template_kwargs: { thinking: true } };
  }

  try {
    const response = await fetchWithRetry(nimBody, {
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: nimBody.stream ? 'stream' : 'json',
      timeout: nimBody.stream ? 0 : config.timeoutMs, 
    });

    stats.success++;

    if (nimBody.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const onClientClose = () => { response.data.destroy(); };
      req.on('close', onClientClose);

      const onAppTerminate = () => { response.data.destroy(); res.end(); };
      process.once('SIGTERM', onAppTerminate);

      const decoder = new TextDecoder('utf-8');
      let buffer = '', inReasoning = false;

      response.data.on('data', chunk => {
        buffer += decoder.decode(chunk, { stream: true });
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
    if (res.headersSent) return res.end();
    
    const status = err.response?.status ?? 500;
    
    // Покращений парсинг помилки, щоб ти точно бачив, на що свариться Mistral
    let message = 'Невідома помилка проксі';
    const errorData = err.response?.data;
    
    if (errorData) {
      if (typeof errorData === 'string') message = errorData;
      else if (errorData.detail) {
        message = typeof errorData.detail === 'string' ? errorData.detail : JSON.stringify(errorData.detail);
      }
      else if (errorData.error?.message) message = errorData.error.message;
    } else if (err.message) {
      message = err.message;
    }

    if (status !== 429 && status < 500) stats.errOther++;
    console.error(`[${status}] Proxy Error: ${message}`);
    
    // Відправляємо відформатовану помилку в твій RP-клієнт
    res.status(status).json({ error: { message: `Proxy Error ${status}: ${message}`, code: status } });
  }
});

app.all('*', (req, res) => res.status(404).json({ error: { message: `Ендпоінт ${req.path} не знайдено` } }));

process.on('SIGTERM', () => {
  console.log('SIGTERM отримано, завершую...');
  setTimeout(() => process.exit(0), 3000);
});

app.listen(PORT, () => console.log(`✅ RP-Проксі на порту ${PORT} | /admin для налаштувань`));

const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const helpers = require('../utils/helpers'); // Імпортуємо весь об'єкт, щоб міняти config всередині

let ADMIN_KEY = process.env.ADMIN_KEY ?? '';
if (!ADMIN_KEY) {
  ADMIN_KEY = randomUUID();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║         🔑 ADMIN KEY (згенеровано авто)          ║');
  console.log(`║  ${ADMIN_KEY}  ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
}

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
    .endpoints-info{background:#12121a;border-radius:10px;padding:12px;margin-top:4px;font-size:12px;color:#666;line-height:1.8}
    code{background:#1e1e2e;padding:1px 5px;border-radius:4px;color:#a0c080;font-size:11px}
  </style>
</head>
<body>
  <h1>🚀 NIM Universal Proxy</h1>
  <p class="sub">Підтримує: chat · embeddings · images (genai + integrate) · audio · TTS · STT</p>
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
    <div class="card-title">🔁 Retry при 5xx</div>
    <div class="row"><div><div class="lbl">Кількість спроб</div></div><input class="num" type="number" id="maxRetries" min="0" max="5"></div>
    <div class="row"><div><div class="lbl">Пауза (мс)</div></div><input class="num" type="number" id="retryDelayMs" min="100" step="100"></div>
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
        $('sTotal').textContent = s.total; $('sSuccess').textContent = s.success;
        $('s429').textContent = s.err429; $('s5xx').textContent = s.err5xx;
        $('uptimeEl').textContent = 'Аптайм: ' + fmtUptime(s.uptimeMs);
        const ep = s.byEndpoint ?? {};
        const keys = Object.keys(ep);
        if (keys.length) $('epGrid').innerHTML = keys.sort((a,b)=>ep[b]-ep[a]).map(k =>
          \`<div class="ep-name">\${k}</div><div class="ep-cnt">\${ep[k]}</div>\`).join('');
      } catch {}
    }
    async function load() {
      try {
        const c = await fetch('/admin/config').then(r=>r.json());
        $('enableThinking').checked = c.enableThinking; $('showReasoning').checked = c.showReasoning;
        $('maxRetries').value = c.maxRetries; $('retryDelayMs').value = c.retryDelayMs;
      } catch {}
    }
    async function save() {
      const body = {
        enableThinking: $('enableThinking').checked, showReasoning: $('showReasoning').checked,
        maxRetries: +$('maxRetries').value, retryDelayMs: +$('retryDelayMs').value,
      };
      const headers = {'Content-Type':'application/json'};
      const ki = $('keyInput'); if (ki) headers['x-admin-key'] = ki.value;
      try {
        const r = await fetch('/admin/config', {method:'POST', headers, body: JSON.stringify(body)});
        if (r.ok) { $('status').innerHTML = '<span class="ok">✓ Збережено</span>'; setTimeout(()=>$('status').innerHTML='', 2500); }
        else { const e = await r.json(); $('status').innerHTML = '<span class="errt">'+(e.error||'Помилка')+'</span>'; }
      } catch { $('status').innerHTML = '<span class="errt">Помилка мережі</span>'; }
    }
    load(); loadStats(); setInterval(loadStats, 10000);
  </script>
</body>
</html>`;
}

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildAdminHtml());
});

router.get('/config', (req, res) => res.json(helpers.config));

router.get('/stats', (req, res) => res.json({ 
  ...helpers.stats, 
  uptimeMs: Date.now() - helpers.stats.startTime 
}));

router.post('/config', (req, res) => {
  if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Невірний ключ' });
    
  for (const [key, val] of Object.entries(req.body)) {
    if (!(key in helpers.config)) continue;
    helpers.config[key] = typeof helpers.config[key] === 'boolean' ? Boolean(val) : Number(val);
  }
  console.log('Config оновлено за допомогою адмінки:', helpers.config);
  res.json({ success: true, config: helpers.config });
});

module.exports = router;

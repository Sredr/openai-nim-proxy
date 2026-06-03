const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const { stats, config } = require('../utils/helpers');

let ADMIN_KEY = process.env.ADMIN_KEY ?? '';
if (!ADMIN_KEY) {
  ADMIN_KEY = randomUUID();
  console.log(`\n🔑 ADMIN KEY (згенеровано авто): ${ADMIN_KEY}\n`);
}

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>Universal Proxy</title><style>body{background:#0f0f13;color:#e0e0e0;font-family:sans-serif;padding:20px} .card{background:#1a1a24;padding:15px;margin-bottom:10px;border-radius:10px}</style></head><body><h1>🚀 Gateway Admin</h1><div class="card">Всього запитів: <b id="tot"></b> | Успіх: <b id="suc"></b></div><script>setInterval(async()=>{const r = await fetch('/admin/stats').then(res=>res.json()); document.getElementById('tot').innerText=r.total; document.getElementById('suc').innerText=r.success;}, 2000);</script></body></html>`);
});

router.get('/config', (req, res) => res.json(config));
router.get('/stats', (req, res) => res.json({ ...stats, uptimeMs: Date.now() - stats.startTime }));

router.post('/config', (req, res) => {
  if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Невірний ключ' });
  for (const [key, val] of Object.entries(req.body)) if (key in config) config[key] = typeof config[key] === 'boolean' ? Boolean(val) : Number(val);
  res.json({ success: true, config });
});

module.exports = router;
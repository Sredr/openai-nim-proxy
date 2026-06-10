require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { stats, trackEndpoint, fetchWithRetry, extractApiKey, handleError, config } = require('./src/utils/helpers');

const chatRoutes = require('./src/routes/chat');
const mediaRoutes = require('./src/routes/media');
const adminRoutes = require('./src/routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

app.use(cors());
// Render free tier має 512MB RAM. 50mb тіло може вбити сервіс при кількох
// одночасних запитах — знижуємо до розумного ліміту.
app.use(express.json({ limit: '10mb' }));

app.use('/v1', chatRoutes);
app.use('/v1', mediaRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Date.now() - stats.startTime,
  // Корисно для дебагу — видно поточний конфіг без адмінки
  config: {
    timeoutMs: config.timeoutMs,
    streamConnectTimeoutMs: config.streamConnectTimeoutMs,
    keepaliveIntervalMs: config.keepaliveIntervalMs,
    maxRetries: config.maxRetries,
  }
}));

// Pass-through для всіх інших /v1/* ендпоінтів (embeddings, completions, models)
app.all('/v1/*', async (req, res) => {
  const nimPath = req.path.replace(/^\/v1/, '');
  const isStream = req.body?.stream === true;
  
  stats.total++; 
  trackEndpoint(`${req.method} ${nimPath}`);
  
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  }

  try {
    const response = await fetchWithRetry({
      method: req.method.toLowerCase(),
      url: `${NIM_API_BASE}${nimPath}`,
      data: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      params: req.query,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: isStream ? 'stream' : 'json',
      timeout: config.timeoutMs,
    });
    stats.success++;
    
    if (isStream) {
      res.setHeader('Content-Type', response.headers['content-type'] ?? 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // ← вимикає буферизацію nginx на Render
      response.data.pipe(res);
    } else {
      const ct = response.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      res.status(response.status).json(response.data);
    }
  } catch (err) { 
    handleError(err, res); 
  }
});

app.all('*', (req, res) => res.status(404).json({
  error: { message: `Ендпоінт не знайдено. Всі роути доступні через /v1/*` }
}));

// Render дає 30 секунд на graceful shutdown.
// Активні стріми отримують час завершитись.
let isShuttingDown = false;
process.on('SIGTERM', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('SIGTERM отримано, завершую через 28с...');
  setTimeout(() => {
    console.log('Завершення процесу');
    process.exit(0);
  }, 28000);
});

app.listen(PORT, () => {
  console.log(`✅ Universal Proxy запущено на порту ${PORT}`);
  console.log(`   streamConnectTimeoutMs = ${config.streamConnectTimeoutMs}`);
  console.log(`   keepaliveIntervalMs    = ${config.keepaliveIntervalMs}`);
  console.log(`   timeoutMs              = ${config.timeoutMs}`);
});

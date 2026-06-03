require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { stats, trackEndpoint, fetchWithRetry, extractApiKey, handleError, config } = require('./src/utils/helpers');

// Імпорт маршрутів
const chatRoutes = require('./src/routes/chat');
const mediaRoutes = require('./src/routes/media');
const adminRoutes = require('./src/routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Підключення модулів
app.use('/v1', chatRoutes);
app.use('/v1', mediaRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Date.now() - stats.startTime }));

// Pass-through для всіх інших /v1/* ендпоінтів (embeddings, completions, models)
app.all('/v1/*', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  
  const nimPath = req.path.replace(/^\/v1/, '');
  const isStream = req.body?.stream === true;
  stats.total++; trackEndpoint(`${req.method} ${nimPath}`);
  
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
      response.data.pipe(res);
    } else {
      const ct = response.headers['content-type'];
      if (ct) res.setHeader('Content-Type', ct);
      res.status(response.status).json(response.data);
    }
  } catch (err) { handleError(err, res); }
});

app.all('*', (req, res) => res.status(404).json({
  error: { message: `Ендпоінт не знайдено. Всі роути доступні через /v1/*` }
}));

process.on('SIGTERM', () => {
  console.log('SIGTERM отримано, завершую...');
  setTimeout(() => process.exit(0), 3000);
});

app.listen(PORT, () => console.log(`✅ Universal Proxy запущено на порту ${PORT}`));

const axios = require('axios');

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

const stats = {
  total: 0, success: 0,
  err429: 0, err5xx: 0, errOther: 0,
  byEndpoint: {},
  startTime: Date.now(),
};

function trackEndpoint(name) {
  stats.byEndpoint[name] = (stats.byEndpoint[name] ?? 0) + 1;
}

async function fetchWithRetry(axiosConfig) {
  let attempts5xx = 0, attempts429 = 0;
  while (true) {
    try {
      return await axios(axiosConfig);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempts429 < config.max429Retries) {
        attempts429++; stats.err429++;
        const delay = (parseInt(err.response?.headers?.['retry-after'] ?? '0') * 1000) || config.retry429DelayMs;
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

function extractApiKey(req, providerName = 'nvidia') {
  const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];
  if (envKey) return envKey;
  const authHeader = req.headers['authorization'] ?? '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!raw) return null;
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
}

function safeStringify(val) {
  try { return JSON.stringify(val); } catch { return String(val); }
}

function handleError(err, res) {
  const status = err.response?.status ?? 500;
  const rawData = err.response?.data;
  let message = 'Помилка';
  
  if (rawData?.detail) message = typeof rawData.detail === 'string' ? rawData.detail : safeStringify(rawData.detail);
  else if (rawData?.error?.message) message = rawData.error.message;
  else if (typeof err.message === 'string') message = err.message;

  if (status !== 429 && status < 500) stats.errOther++;
  console.error(`[${status}]`, rawData !== undefined ? safeStringify(rawData) : `"${err.message}"`);
  if (res && !res.headersSent) res.status(status).json({ error: { message, code: status } });
}

module.exports = { config, stats, trackEndpoint, fetchWithRetry, extractApiKey, handleError };
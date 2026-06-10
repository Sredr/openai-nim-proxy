const axios = require('axios');

const config = {
  showReasoning:            process.env.SHOW_REASONING !== 'false',
  enableThinking:           process.env.ENABLE_THINKING === 'true',
  maxRetries:               parseInt(process.env.MAX_RETRIES ?? '2'),
  retryDelayMs:             parseInt(process.env.RETRY_DELAY_MS ?? '1000'),
  max429Retries:            parseInt(process.env.MAX_429_RETRIES ?? '3'),
  retry429DelayMs:          parseInt(process.env.RETRY_429_DELAY_MS ?? '5000'),
  defaultTemperature:       parseFloat(process.env.DEFAULT_TEMPERATURE ?? '0.6'),
  defaultMaxTokens:         parseInt(process.env.DEFAULT_MAX_TOKENS ?? '2048'),
  // Таймаут для звичайних (non-stream) запитів
  timeoutMs:                parseInt(process.env.TIMEOUT_MS ?? '85000'),
  // Таймаут на встановлення з'єднання + перший байт для стрімінгу.
  // Thinking-моделі можуть мовчати 60-90с перед початком стріму.
  // 120с = достатньо для DeepSeek-R1, QwQ, Gemini thinking.
  streamConnectTimeoutMs:   parseInt(process.env.STREAM_CONNECT_TIMEOUT_MS ?? '120000'),
  // Інтервал keepalive ping для Render (не більше 25с, бо Render вбиває за 30с idle)
  keepaliveIntervalMs:      parseInt(process.env.KEEPALIVE_INTERVAL_MS ?? '20000'),
};

const stats = {
  total: 0, success: 0,
  err429: 0, err5xx: 0, errOther: 0,
  byEndpoint: {},
  byProvider: {},
  startTime: Date.now(),
};

function trackEndpoint(name) {
  stats.byEndpoint[name] = (stats.byEndpoint[name] ?? 0) + 1;
}

function trackProvider(name) {
  stats.byProvider[name] = (stats.byProvider[name] ?? 0) + 1;
}

async function fetchWithRetry(axiosConfig) {
  let attempts5xx = 0, attempts429 = 0;
  while (true) {
    try {
      return await axios(axiosConfig);
    } catch (err) {
      const status = err.response?.status;
      // ── 429 Rate Limit ───────────────────────────────────────────────────
      if (status === 429 && attempts429 < config.max429Retries) {
        attempts429++; stats.err429++;
        const delay = (parseInt(err.response?.headers?.['retry-after'] ?? '0') * 1000) || config.retry429DelayMs;
        console.log(`[429] Retry ${attempts429}/${config.max429Retries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // ── 5xx Server Error ─────────────────────────────────────────────────
      if (status != null && status >= 500 && attempts5xx < config.maxRetries) {
        attempts5xx++; stats.err5xx++;
        const delay = config.retryDelayMs * Math.pow(2, attempts5xx - 1);
        console.log(`[${status}] Retry ${attempts5xx}/${config.maxRetries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // ── Network / Timeout errors (status=undefined) ──────────────────────
      // ВАЖЛИВО: раніше тут був баг — `undefined >= 500` = false,
      // тому таймаути і мережеві помилки не ретраїлись ніколи.
      const isRetryableNetworkErr = status == null && attempts5xx < config.maxRetries;
      if (isRetryableNetworkErr) {
        attempts5xx++;
        const delay = config.retryDelayMs * Math.pow(2, attempts5xx - 1);
        console.log(`[${err.code ?? 'NetworkError'}] Retry ${attempts5xx}/${config.maxRetries} через ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

const PROVIDER_ORDER = ['nvidia', 'google', 'groq'];

function extractApiKey(req, providerName = 'nvidia') {
  const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];
  if (envKey) return envKey;

  const authHeader = req.headers['authorization'] ?? '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!raw) return null;

  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  
  if (keys.length > 1) {
    const idx = PROVIDER_ORDER.indexOf(providerName);
    return keys[idx % keys.length];
  }
  
  return keys[0];
}

function safeStringify(val) {
  try { return JSON.stringify(val); } catch { return String(val); }
}

function classifyError(err) {
  const status = err.response?.status;
  const code = err.code;
  if (status === 429) return '429 Rate Limit';
  if (status >= 500) return `${status} Server Error`;
  if (status >= 400) return `${status} Client Error`;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'Timeout';
  if (code === 'ECONNRESET') return 'Connection Reset';
  if (code === 'ENOTFOUND') return 'DNS Error';
  if (code === 'ECONNREFUSED') return 'Connection Refused';
  return code ?? 'Unknown Error';
}

function handleError(err, res) {
  const status = err.response?.status ?? 500;
  const rawData = err.response?.data;
  const errClass = classifyError(err);
  let message = 'Помилка';
  
  if (rawData?.detail) message = typeof rawData.detail === 'string' ? rawData.detail : safeStringify(rawData.detail);
  else if (rawData?.error?.message) message = rawData.error.message;
  else if (typeof err.message === 'string') message = err.message;

  if (status !== 429 && status < 500) stats.errOther++;
  console.error(`[${errClass}]`, rawData !== undefined ? safeStringify(rawData) : `"${err.message}"`);
  if (res && !res.headersSent) res.status(status).json({ error: { message, code: status } });
}

module.exports = { config, stats, trackEndpoint, trackProvider, fetchWithRetry, extractApiKey, handleError };

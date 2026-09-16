const axios = require('axios');
const http = require('http');
const https = require('https');

// HTTP keep-alive агенти для швидшого з'єднання
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100, timeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, timeout: 60000 });

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

// ── Метрики ──────────────────────────────────────────────────────────────────
// Два інваріанти, які адмінка перевіряє:
//   1) total  = success + failed
//   2) failed = err429 + err5xx + errOther + errTimeout + errNetwork
// err* рахують ФІНАЛЬНИЙ результат запиту (а не кожну спробу ретраю),
// тому суми завжди сходяться. Ретраї видно окремо в retries/retriedOk.
const stats = {
  total: 0, success: 0, failed: 0,
  retries: 0, retriedOk: 0,
  err429: 0, err5xx: 0, errOther: 0, errTimeout: 0, errNetwork: 0,
  byEndpoint: {},
  byProvider: {},
  errorsByProvider: {},
  startTime: Date.now(),
};

function trackEndpoint(name) {
  stats.byEndpoint[name] = (stats.byEndpoint[name] ?? 0) + 1;
}

function trackProvider(name) {
  stats.byProvider[name] = (stats.byProvider[name] ?? 0) + 1;
}

async function fetchWithRetry(axiosConfig, opts = {}) {
  // Додаємо keep-alive агенти до конфігу
  if (!axiosConfig.httpAgent && !axiosConfig.httpsAgent) {
    axiosConfig.httpAgent = httpAgent;
    axiosConfig.httpsAgent = httpsAgent;
  }

  const maxRetries = opts.maxRetries ?? config.maxRetries;
  const max429Retries = opts.max429Retries ?? config.max429Retries;
  const maxNetworkRetries = opts.maxNetworkRetries ?? config.maxRetries;
  const signal = opts.signal ?? axiosConfig.signal;

  let attempts5xx = 0, attempts429 = 0, attemptsNet = 0, retried = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const backoff = n => config.retryDelayMs * Math.pow(2, n - 1);

  while (true) {
    try {
      const response = await axios(axiosConfig);
      // Запит вижив після повторів — видно, що ретраї реально працюють
      if (retried > 0) stats.retriedOk++;
      return response;
    } catch (err) {
      // Клієнт відключився (Stop у клієнті, закрита вкладка) — не молотимо далі
      if (signal?.aborted || err.code === 'ERR_CANCELED') throw err;

      const status = err.response?.status;
      const retryAfterMs = (parseInt(err.response?.headers?.['retry-after'] ?? '0') * 1000) || config.retry429DelayMs;

      // ── 429 Rate Limit (поважаємо Retry-After від провайдера) ────────────
      if (status === 429 && attempts429 < max429Retries) {
        attempts429++; retried++; stats.retries++;
        console.log(`[429] Retry ${attempts429}/${max429Retries} через ${retryAfterMs}ms`);
        await sleep(retryAfterMs);
        continue;
      }
      // ── 5xx Server Error ─────────────────────────────────────────────────
      if (status != null && status >= 500 && attempts5xx < maxRetries) {
        attempts5xx++; retried++; stats.retries++;
        console.log(`[${status}] Retry ${attempts5xx}/${maxRetries} через ${backoff(attempts5xx)}ms`);
        await sleep(backoff(attempts5xx));
        continue;
      }
      // ── Network / Timeout errors (status=undefined) ──────────────────────
      // ВАЖЛИВО: раніше тут був баг — `undefined >= 500` = false,
      // тому таймаути і мережеві помилки не ретраїлись ніколи.
      if (status == null && attemptsNet < maxNetworkRetries) {
        attemptsNet++; retried++; stats.retries++;
        console.log(`[${err.code ?? 'NetworkError'}] Retry ${attemptsNet}/${maxNetworkRetries} через ${backoff(attemptsNet)}ms`);
        await sleep(backoff(attemptsNet));
        continue;
      }
      throw err;
    }
  }
}

// ── Класифікація помилок + фіксація результату запиту ────────────────────────
// '429' | '5xx' | '4xx' | 'timeout' | 'network' | 'other'
function errorKindOf(err) {
  const status = err?.response?.status;
  const code = err?.code;
  if (status === 429) return '429';
  if (status != null && status >= 500) return '5xx';
  if (status != null && status >= 400) return '4xx';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
      || code === 'EHOSTUNREACH' || code === 'EAI_AGAIN' || code === 'ERR_CANCELED') return 'network';
  if (status != null) return '4xx';
  return 'other';
}

const ERROR_FIELD_BY_KIND = {
  '429': 'err429',
  '5xx': 'err5xx',
  '4xx': 'errOther',
  timeout: 'errTimeout',
  network: 'errNetwork',
  other: 'errOther',
};

// Єдина точка фіксації РЕЗУЛЬТАТУ запиту — саме тому інваріант total = success + failed
// тепер тримається (раніше stats.success++ стояв у кількох місцях, а помилки
// у chat-роуті не рахувались узагалі).
function registerOutcome(err, providerName) {
  if (err == null) {
    stats.success++;
    return 'success';
  }

  const kind = errorKindOf(err);
  stats.failed++;
  stats[ERROR_FIELD_BY_KIND[kind]]++;

  if (providerName) {
    const byProvider = stats.errorsByProvider[providerName] ?? (stats.errorsByProvider[providerName] = {});
    byProvider[kind] = (byProvider[kind] ?? 0) + 1;
  }

  return kind;
}

// Ранні відмови (немає ключа, невалідний ключ, невалідна модель) теж мають
// потрапляти у статистику — інакше такі запити «зникають» між total і success.
function sendError(res, status, message, providerName) {
  registerOutcome(Object.assign(new Error(message), { response: { status } }), providerName);
  if (res && !res.headersSent) {
    res.status(status).json({ error: { message, code: status } });
  } else if (res && !res.writableEnded) {
    res.end();
  }
  return status;
}

const PROVIDER_ORDER = ['nvidia', 'google', 'groq', 'openrouter', 'cloudflare', 'github', 'mistral', 'cohere', 'deepseek'];

const keyRotationState = {};

function getProviderKeys(providerName) {
  // Спробуємо спочатку plural версію (напр. GOOGLE_API_KEYS), потім singular
  const keysEnv = process.env[`${providerName.toUpperCase()}_API_KEYS`] || process.env[`${providerName.toUpperCase()}_API_KEY`];
  if (!keysEnv) return [];
  return keysEnv.split(',').map(k => k.trim()).filter(Boolean);
}

function extractApiKey(req, providerName = 'nvidia') {
  // 1. Перевіряємо заголовки (для динамічного керування ключами клієнтом)
  const authHeader = req.headers['authorization'] ?? '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (raw) {
    const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 1) {
      const idx = PROVIDER_ORDER.indexOf(providerName);
      return keys[idx % keys.length];
    }
    return keys[0];
  }

  // 2. Використовуємо ротацію ключів з .env
  const keys = getProviderKeys(providerName);
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];

  // Ротація: збільшуємо індекс для кожного провайдера
  keyRotationState[providerName] = (keyRotationState[providerName] ?? 0);
  const key = keys[keyRotationState[providerName] % keys.length];
  keyRotationState[providerName]++;

  return key;
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

function handleError(err, res, providerName) {
  const status = err.response?.status ?? 500;
  const rawData = err.response?.data;
  const errClass = classifyError(err);
  let message = 'Помилка';

  if (rawData?.detail) message = typeof rawData.detail === 'string' ? rawData.detail : safeStringify(rawData.detail);
  else if (rawData?.error?.message) message = rawData.error.message;
  else if (typeof err.message === 'string') message = err.message;

  // Фінальний результат запиту — рахуємо і 429, і 5xx, і таймаути (раніше
  // рахувались тільки 4xx≠429, тому дашборд показував нулі).
  const kind = registerOutcome(err, providerName);
  console.error(`[${errClass}${kind ? ` | ${kind}` : ''}]`, rawData !== undefined ? safeStringify(rawData) : `"${err.message}"`);
  if (res && !res.headersSent) res.status(status).json({ error: { message, code: status } });
}

module.exports = {
  config, stats, trackEndpoint, trackProvider,
  fetchWithRetry, extractApiKey, handleError, errorKindOf, registerOutcome, sendError,
  httpAgent, httpsAgent,
};
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
  // ── Пул ключів ────────────────────────────────────────────────────────
  // Скільки різних ключів максимум пробувати в межах одного запиту
  maxKeyAttempts:           parseInt(process.env.MAX_KEY_ATTEMPTS ?? '3'),
  // Скільки тримати ключ у cooldown після 429 (якщо провайдер не дав Retry-After)
  keyCooldownMs:            parseInt(process.env.KEY_COOLDOWN_MS ?? '30000'),
  // На скільки вимикати ключ після 401/403 (невірний/відкликаний ключ)
  keyBanMs:                 parseInt(process.env.KEY_BAN_MS ?? '1800000'),
};

// ── Метрики ──────────────────────────────────────────────────────────────────
// Дві різні речі, які легко переплутати:
//   • err*   — ФАКТИ помилок від upstream (кожна спроба, разом із тими, що
//              вдалось вилікувати ретраєм). Саме це власник хоче бачити:
//              «429 rate limit» більше не показує 0, коли провайдер лімітує.
//   • failed — фінальні невдачі запитів (те, що клієнт реально отримав як помилку).
// Інваріанти, які перевіряє адмінка:
//   1) total = success + failed
//   2) сума failedByKind = failed
//   3) сума err* >= failed  (різниця = помилки, вилікувані ретраями)
const stats = {
  total: 0, success: 0, failed: 0,
  retries: 0, retriedOk: 0,
  err429: 0, err5xx: 0, errOther: 0, errTimeout: 0, errNetwork: 0,
  failedByKind: {},
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

      // Кожна помилка від upstream потрапляє в статистику одразу — навіть якщо
      // наступний ретрай її вилікує (інакше 429 від провайдера були б невидні)
      countUpstreamError(err, opts.providerName);

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

// Рахує ФАКТ помилки від upstream — викликається в момент спостереження
// (у fetchWithRetry на кожній спробі, у стрімі, у ранніх відмовах).
// Флаг __counted гарантує, що одна й та сама помилка не порахується двічі
// (наприклад, у fetchWithRetry і потім у handleError).
function countUpstreamError(err, providerName) {
  if (err == null) return null;
  const kind = errorKindOf(err);
  if (err.__counted) return kind;
  err.__counted = true;

  stats[ERROR_FIELD_BY_KIND[kind]]++;

  if (providerName) {
    const byProvider = stats.errorsByProvider[providerName] ?? (stats.errorsByProvider[providerName] = {});
    byProvider[kind] = (byProvider[kind] ?? 0) + 1;
  }

  return kind;
}

// Єдина точка фіксації РЕЗУЛЬТАТУ запиту для клієнта — саме тому інваріант
// total = success + failed тепер тримається (раніше stats.success++ стояв у
// кількох місцях, а помилки у chat-роуті не рахувались узагалі).
function registerOutcome(err, providerName) {
  if (err == null) {
    stats.success++;
    return 'success';
  }

  const kind = countUpstreamError(err, providerName);
  stats.failed++;
  stats.failedByKind[kind] = (stats.failedByKind[kind] ?? 0) + 1;

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

// ── Пул ключів зі станом ─────────────────────────────────────────────────────
// Раніше тут була «сліпа» кругова ротація: ключ змінювався лише наступним
// запитом, і ніхто не пам'ятав, що ключ щойно віддав 429 або 401. Тепер кожен
// ключ має стан: cooldown після 429 і тимчасове вимкнення після 401/403.

const KEY_LONG_COOLDOWN_MS = 5 * 60 * 1000;   // якщо ключ ловить 429 підряд
const KEY_LONG_COOLDOWN_AFTER = 3;

const keyPool = {};   // provider → Map(value → { failures, cooldownUntil, disabledUntil, lastUsedAt })

function getProviderKeys(providerName) {
  // Спробуємо спочатку plural версію (напр. GOOGLE_API_KEYS), потім singular
  const keysEnv = process.env[`${providerName.toUpperCase()}_API_KEYS`] || process.env[`${providerName.toUpperCase()}_API_KEY`];
  if (!keysEnv) return [];
  return keysEnv.split(',').map(k => k.trim()).filter(Boolean);
}

function maskKey(value) {
  if (!value) return 'null';
  return value.length <= 10 ? value.slice(0, 3) + '…' : value.slice(0, 6) + '…' + value.slice(-3);
}

function getKeyState(providerName, value) {
  const pool = keyPool[providerName] ?? (keyPool[providerName] = new Map());
  let state = pool.get(value);
  if (!state) {
    state = { value, failures: 0, cooldownUntil: 0, disabledUntil: 0, lastUsedAt: 0 };
    pool.set(value, state);
  }
  return state;
}

// 0 — ключ живий, 1 — у cooldown, 2 — вимкнений. Менший ранг = раніше в черзі.
function keyRank(state, now) {
  if (state.disabledUntil > now) return 2;
  if (state.cooldownUntil > now) return 1;
  return 0;
}

// Черга кандидатів: спершу найдовше не вживані «живі» ключі, потім ті, в кого
// cooldown уже сплив, і лише в останню чергу — вимкнені. Ключі клієнта
// (Authorization) мають пріоритет над .env, як і раніше, але ключ у cooldown
// завжди пропускається на користь робочого.
function getKeyCandidates(req, providerName = 'nvidia') {
  const now = Date.now();
  const found = [];

  const authHeader = req?.headers?.['authorization'] ?? '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (raw) {
    for (const value of raw.split(',').map(k => k.trim()).filter(Boolean)) {
      found.push({ value, source: 'header' });
    }
  }
  for (const value of getProviderKeys(providerName)) {
    found.push({ value, source: 'env' });
  }

  const seen = new Set();
  const unique = [];
  for (const candidate of found) {
    if (seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    candidate.state = getKeyState(providerName, candidate.value);
    unique.push(candidate);
  }

  unique.sort((a, b) => {
    const rankDiff = keyRank(a.state, now) - keyRank(b.state, now);
    if (rankDiff !== 0) return rankDiff;
    if (a.source !== b.source) return a.source === 'header' ? -1 : 1;  // ключі клієнта — першими
    return a.state.lastUsedAt - b.state.lastUsedAt;                     // LRU всередині групи
  });

  return unique;
}

function markKeyUsed(providerName, value) {
  getKeyState(providerName, value).lastUsedAt = Date.now();
}

function markKeySuccess(providerName, value) {
  const state = getKeyState(providerName, value);
  state.failures = 0;
  state.cooldownUntil = 0;
  state.disabledUntil = 0;
  state.lastUsedAt = Date.now();
}

// Повертає 'disabled' | 'cooldown' | 'untouched' — щоб роут знав, чи є сенс
// пробувати наступний ключ, чи проблема взагалі не в ключі.
function markKeyFailure(providerName, value, status, retryAfterMs = 0) {
  const state = getKeyState(providerName, value);
  const now = Date.now();
  state.lastUsedAt = now;

  if (status === 401 || status === 403) {
    state.failures++;
    state.disabledUntil = now + config.keyBanMs;
    console.log(`[Keys] ⛔ ${providerName}: ключ ${maskKey(value)} вимкнено на ${Math.round(config.keyBanMs / 1000)}с (HTTP ${status})`);
    return 'disabled';
  }

  if (status === 429) {
    state.failures++;
    const base = retryAfterMs > 0 ? retryAfterMs : config.keyCooldownMs;
    const cooldown = state.failures >= KEY_LONG_COOLDOWN_AFTER ? Math.max(base, KEY_LONG_COOLDOWN_MS) : base;
    state.cooldownUntil = now + cooldown;
    console.log(`[Keys] ⏳ ${providerName}: ключ ${maskKey(value)} у cooldown ${Math.round(cooldown / 1000)}с (429, підряд ${state.failures})`);
    return 'cooldown';
  }

  // 5xx / мережа / таймаут — ключ не винен, стан не чіпаємо
  return 'untouched';
}

// Для тестів і дебагу: стан пула без саміх ключів (тільки маски)
function getKeyPoolSnapshot(providerName) {
  const pool = keyPool[providerName];
  if (!pool) return [];
  const now = Date.now();
  return [...pool.values()].map(state => ({
    key: maskKey(state.value),
    failures: state.failures,
    availability: state.disabledUntil > now ? 'disabled' : (state.cooldownUntil > now ? 'cooldown' : 'ok'),
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
  }));
}

// Сумісний API: повертає один ключ — перший кандидат із черги.
// Тут же виправлено баг, коли PROVIDER_ORDER.indexOf() === -1 давав keys[-1]
// === undefined, і запит ішов узагалі без ключа.
function extractApiKey(req, providerName = 'nvidia') {
  const candidates = getKeyCandidates(req, providerName);
  if (candidates.length === 0) return null;
  markKeyUsed(providerName, candidates[0].value);
  return candidates[0].value;
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
  fetchWithRetry, extractApiKey, handleError, errorKindOf, registerOutcome, countUpstreamError, sendError,
  getKeyCandidates, markKeyUsed, markKeySuccess, markKeyFailure, getKeyPoolSnapshot,
  httpAgent, httpsAgent,
};
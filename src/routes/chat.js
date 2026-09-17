const express = require('express');
const router = express.Router();
const providersConfig = require('../../config/providers.json');
let routerConfig = { aliases: {} };
try {
  routerConfig = require('../../config/router.json');
} catch {
  // router.json is optional — if missing, no aliases, only exact model names work
}
const adapters = require('../adapters');
const { getKeyCandidates, markKeySuccess, markKeyFailure, fetchWithRetry, handleError, trackEndpoint, trackProvider, registerOutcome, sendError, stats, config, httpAgent, httpsAgent } = require('../utils/helpers');

function resolveModelChain(modelName, visited = new Set()) {
  if (visited.has(modelName)) return [];
  visited.add(modelName);
  
  const chain = routerConfig.aliases?.[modelName];
  if (chain) {
    let resolvedChain = [];
    for (const item of chain) resolvedChain.push(...resolveModelChain(item, visited));
    return resolvedChain;
  }
  
  return [modelName];
}

// SSE-заголовки для стрімінгу через nginx (Render, Railway, Heroku тощо).
// X-Accel-Buffering: no — вимикає буферизацію nginx, без нього nginx
// накопичує весь стрім і відправляє одним шматком тільки після закриття з'єднання.
function setStreamHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // ← КРИТИЧНО для Render/nginx
  // res.flush() тут не викликаємо — Node.js HTTP responses мають Nagle disabled
  // за замовчуванням, тому write() одразу йде в мережу без буферизації.
  // Надмірний flush() лише збільшує кількість дрібних TCP-пакетів.
}

// ── KEEPALIVE для thinking-моделей ───────────────────────────────────────────
// Render Free обриває з'єднання якщо 30с немає байт у відповіді.
// Thinking-моделі (DeepSeek-R1, Gemini-thinking, QwQ тощо) можуть мовчати
// 30-120с під час фази "роздумів" перш ніж почати стрімити.
// Рішення: надсилаємо SSE-comment кожні 20с — клієнти їх ігнорують,
// але Render/nginx бачать активність і не вбивають з'єднання.
function startKeepalive(res, intervalMs = 20000) {
  const timer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(timer);
      return;
    }
    try {
      // SSE comment — специфікація дозволяє, всі клієнти ігнорують
      res.write(': ping\n\n');
      if (res.flush) res.flush();
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  return timer;
}

router.post('/chat/completions', async (req, res) => {
  stats.total++; trackEndpoint('POST /v1/chat/completions');
  
  // ── Multi-model support: "model1,model2" OR ["model1","model2"] OR single ──
  let requestedModels = req.body.model || 'default';
  if (Array.isArray(requestedModels)) {
    // already array
  } else if (typeof requestedModels === 'string') {
    requestedModels = requestedModels.split(',').map(m => m.trim()).filter(Boolean);
  } else {
    requestedModels = ['default'];
  }
  // Build full chain: each requested model expands through aliases
  const modelChain = requestedModels.flatMap(m => resolveModelChain(m));

  if (req.body.messages) {
    let sanitizedMessages = [];
    let systemContent = '';
    for (const msg of req.body.messages) {
      const cleanMsg = { role: msg.role, content: msg.content ?? '' };
      if (cleanMsg.role === 'system') systemContent += (systemContent ? '\n\n' : '') + cleanMsg.content;
      else {
        const last = sanitizedMessages[sanitizedMessages.length - 1];
        if (last && last.role === cleanMsg.role) last.content += '\n\n' + cleanMsg.content;
        else sanitizedMessages.push(cleanMsg);
      }
    }
    if (systemContent) sanitizedMessages.unshift({ role: 'system', content: systemContent });
    req.body.messages = sanitizedMessages;
  }

  const isStream = req.body.stream === true;

  let lastError = null;

  // Скасовуємо активні спроби, якщо клієнт відключився (Stop у клієнті,
  // закрита вкладка) — інакше ретраї молотять провайдера даремно.
  const abortController = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      abortController.abort();
    }
  });

  // Провайдер, на якому зупинився ланцюжок — потрібен для статистики помилок по провайдерах
  let lastProviderName = 'nvidia';

  for (const actualModelPath of modelChain) {
    let keepaliveTimer = null;

    try {
      let providerName = 'nvidia'; 
      let pureModelName = actualModelPath;

      if (actualModelPath.includes('/')) {
        const parts = actualModelPath.split('/');
        const firstPart = parts[0].toLowerCase();
        
        if (providersConfig[firstPart]) {
          providerName = firstPart;
          pureModelName = parts.slice(1).join('/'); 
        } else {
          providerName = 'nvidia';
          pureModelName = actualModelPath;
        }
      }

      const provider = providersConfig[providerName] || providersConfig['nvidia'];
      lastProviderName = providerName;

      // ── Ключі: черга кандидатів замість одного ключа ─────────────────────
      // Ключі в cooldown/бані переміщуються в кінець черги, тому проблемний
      // ключ більше не «зʼїдає» запит — пробуємо наступний.
      const candidates = getKeyCandidates(req, providerName).slice(0, Math.max(1, config.maxKeyAttempts));

      if (candidates.length === 0) { 
        console.warn(`[Router] ⚠️ Ключ відсутній для ${providerName}. Повертаю 401.`); 
        return sendError(res, 401, `API ключ для ${providerName} не знайдено`, providerName);
      }
      
      trackProvider(providerName);
      console.log(`[Router] ➡️ Направляю на: ${providerName} | Модель: ${pureModelName} | stream=${isStream} | ключів у черзі: ${candidates.length}`);

      const adapter = adapters[provider.type] || adapters.openai;
      const requestBody = adapter.formatReq(req.body, pureModelName);

      if (config.enableThinking && providerName === 'nvidia') {
        requestBody.extra_body = { chat_template_kwargs: { thinking: true } };
      }

      let baseUrl = provider.baseUrl;
      if (baseUrl.includes('{CLOUDFLARE_ACCOUNT_ID}')) {
        baseUrl = baseUrl.replace('{CLOUDFLARE_ACCOUNT_ID}', process.env.CLOUDFLARE_ACCOUNT_ID || '');
      }
      // Тестова «щілина»: у тестах upstream підмінюється локальним фейком.
      // У проді змінна не задана, тому поведінка не змінюється.
      if (process.env.TEST_UPSTREAM_BASE) baseUrl = process.env.TEST_UPSTREAM_BASE;

      // ── ТАЙМАУТИ ──────────────────────────────────────────────────────────
      // Axios timeout для stream — це таймаут на з'єднання + перший байт даних
      // (тобто до отримання HTTP-headers від upstream). Після того як headers
      // прийшли — таймаут більше не діє, і стрім може тривати скільки завгодно.
      //
      // Для thinking-моделей: якщо upstream ще не почав відповідати (немає
      // навіть headers) за CONNECT_TIMEOUT — повертаємо помилку і пробуємо
      // наступну модель у chain.
      //
      // Після отримання headers keepalive-таймер тримає з'єднання живим.
      const connectTimeoutMs = isStream
        ? (config.streamConnectTimeoutMs ?? 120000) // 2хв на з'єднання для стрімів
        : config.timeoutMs;                          // 85с для звичайних запитів

      const t0 = Date.now();
      let response = null;
      let keyError = null;
      let lastRetryAfterMs = 0;
      let attemptsMade = 0;

      // ── Круги по ключах при 429 ──────────────────────────────────────────
      // 429 — це ліміт провайдера/моделі, а не провина ключа (буває «спільний»
      // ліміт, який зникає будь-якої секунди). Тому:
      //   • між ключами паузи НЕМАЄ — одразу йдемо на наступний ключ;
      //   • пауза config.retry429DelayMs (3с) робиться МІЖ КРУГАМИ;
      //   • ключ після 429 не блокується (лише позначається як щойно вживаний,
      //     тому наступний запит почне з іншого ключа);
      //   • 401/403 — реальна проблема ключа: ключ вимикається, беремо наступний;
      //   • крутимо, доки не отримаємо відповідь, не вичерпаємо круги
      //     (адмінка: «Кількість кругів при 429») або поки клієнт не відключився.
      const rounds = Math.max(1, config.max429Retries || 1);
      const retryDeadline = Date.now() + Math.max(config.retry429DelayMs, config.retry429MaxWaitMs);

      for (let round = 0; round < rounds && !response; round++) {
        if (round > 0) {
          // Пауза перед новим кругом. Retry-After провайдера поважаємо, але
          // сумарно не даємо клієнту чекати більше retry429MaxWaitMs.
          const waitMs = Math.max(config.retry429DelayMs, Math.min(lastRetryAfterMs, config.retry429MaxWaitMs));
          if (Date.now() + waitMs > retryDeadline) {
            console.log(`[Router] ⏱ Бюджет очікування на 429 вичерпано — припиняю круги на ${pureModelName}`);
            break;
          }
          console.log(`[Router] ⏳ Круг ${round + 1}/${rounds} (ключів: ${candidates.length}) — пауза ${waitMs}ms`);
          await new Promise(r => setTimeout(r, waitMs));
          if (abortController.signal.aborted) break;
        }

        let attemptsThisRound = 0;

        for (const candidate of candidates) {
          if (abortController.signal.aborted) break;
          const apiKey = candidate.value;

          if (typeof apiKey === 'string' && (apiKey === 'nvapi-' || apiKey.endsWith('-') || apiKey.trim().length < 10)) {
            console.warn(`[Router] ⚠️ Ключ для ${providerName} виглядає невалідним — пробую наступний`);
            markKeyFailure(providerName, apiKey, 401);
            keyError = Object.assign(new Error(`Невірний API ключ для ${providerName}`), { response: { status: 401 } });
            continue;
          }

          let reqUrl = `${baseUrl}/chat/completions`;
          const headers = { 'Content-Type': 'application/json' };

          if (provider.type === 'gemini') {
            reqUrl = `${baseUrl}/${pureModelName}:generateContent?key=${apiKey}`;
          } else {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }

          if (attemptsMade > 0) stats.retries++;   // кожна спроба після першої — повтор
          attemptsMade++;
          attemptsThisRound++;

          try {
            // max429Retries: 0 — 429 не ретраїмо всередині fetchWithRetry, щоб
            // одразу перемкнутись на наступний ключ (крутить саме цей цикл)
            response = await fetchWithRetry({
              method: 'post',
              url: reqUrl,
              data: requestBody,
              headers,
              responseType: isStream ? 'stream' : 'json',
              timeout: connectTimeoutMs,
              httpAgent,
              httpsAgent,
              signal: abortController.signal,
            }, { providerName, max429Retries: 0 });

            if (attemptsMade > 1) stats.retriedOk++;
            markKeySuccess(providerName, apiKey);
            break;
          } catch (err) {
            // Клієнт відключився — не продовжуємо спроби
            if (abortController.signal.aborted) throw err;

            const status = err.response?.status;
            lastRetryAfterMs = parseInt(err.response?.headers?.['retry-after'] ?? '0') * 1000;
            const verdict = markKeyFailure(providerName, apiKey, status, lastRetryAfterMs);
            lastError = err;

            // Проблема не в ключі (5xx/мережа/таймаут/4xx) — не палимо інші
            // ключі, а йдемо на наступну модель у ланцюжку
            if (verdict === 'untouched') throw err;

            // 429 (rate-limited) або 401/403 (disabled) → наступний ключ без паузи
            keyError = err;
            console.warn(`[Router] 🔑 ${providerName}: ключ відхилено (HTTP ${status ?? err.code}) → ${verdict}, беру наступний ключ`);
          }
        }

        // Усі ключі виглядають невалідними — крутити далі немає сенсу
        if (attemptsThisRound === 0) break;
      }

      if (!response) {
        throw keyError ?? new Error(`Жоден ключ для ${providerName} не спрацював за ${rounds} круг(ів)`);
      }

      const ttfb = Date.now() - t0;
      console.log(`[Router] ✅ Відповідь від: ${actualModelPath} | TTFB: ${ttfb}ms`);

      if (isStream) {
        setStreamHeaders(res);

        // Запускаємо keepalive ПІСЛЯ setStreamHeaders (щоб заголовки вже пішли)
        keepaliveTimer = startKeepalive(res);

        let bytesReceived = 0;
        let chunkCount = 0;
        let firstChunkAt = 0;         // ms від початку запиту до першого байта тіла
        let lastChunkAt = t0;
        let maxGapMs = 0;             // найбільша пауза між chunks (де upstream "думав")
        const streamStart = Date.now();

        // Результат стріму фіксуємо РІВНО ОДИН раз: Node може віддати і 'end',
        // і 'error' для одного обірваного потоку — без цього запис мав би
        // одночасно +1 до success і +1 до failed.
        let streamOutcomeRecorded = false;
        const recordStreamOutcome = (err) => {
          if (streamOutcomeRecorded) return;
          streamOutcomeRecorded = true;
          // Клієнт сам натиснув Stop — це не помилка проксі
          if (!clientGone) registerOutcome(err, providerName);
        };

        response.data.on('data', chunk => {
          const now = Date.now();
          const gap = now - lastChunkAt;
          if (gap > maxGapMs) maxGapMs = gap;
          lastChunkAt = now;

          if (bytesReceived === 0) firstChunkAt = now - t0; // TTFB тіла (після headers)
          bytesReceived += chunk.length;
          chunkCount++;

          try {
            adapter.parseStream(chunk, res, config);
          } catch (parseErr) {
            console.error(`[Router] ⚠️ parseStream error:`, parseErr.message);
          }
        });

        response.data.on('end', () => {
          clearInterval(keepaliveTimer);
          const totalMs = Date.now() - streamStart;
          const upstreamKBs = totalMs > 0 ? ((bytesReceived / 1024) / (totalMs / 1000)).toFixed(1) : '?';
          console.log(
            `[Router] 🏁 ${actualModelPath}`,
            `| ${(bytesReceived/1024).toFixed(1)}KB в ${chunkCount} chunks за ${totalMs}ms`,
            `| upstream: ${upstreamKBs} KB/s`,
            `| TTFB-body: ${firstChunkAt}ms`,
            `| max-gap: ${maxGapMs}ms`
          );
          if (!res.writableEnded) {
            if (adapter.flushBuffer) adapter.flushBuffer(res, config);
            res.end();
          }
          // Стрім дочитано до кінця — тільки тепер це справжній успіх
          recordStreamOutcome(null);
        });

        response.data.on('error', (streamErr) => {
          clearInterval(keepaliveTimer);
          console.error(`[Router] ❌ Помилка стріму від ${actualModelPath}:`, streamErr.message);
          // Обірваний посеред стріму потік — це помилка, а не успіх
          // (крім випадку, коли клієнт сам натиснув Stop — тоді це не наша помилка)
          recordStreamOutcome(streamErr);
          // Якщо заголовки вже відправлені — не можемо змінити статус.
          // Надсилаємо SSE-error щоб клієнт знав що стрім обірвався.
          if (!res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ error: { message: streamErr.message, type: 'stream_error' } })}\n\n`);
              res.write('data: [DONE]\n\n');
            } catch {}
            res.end();
          }
        });

        // Обробка закриття з'єднання клієнтом (наприклад, SillyTavern натиснув Stop)
        req.on('close', () => {
          clearInterval(keepaliveTimer);
          if (!response.data.destroyed) response.data.destroy();
        });

      } else {
        const finalData = adapter.formatRes(response.data, config);
        res.json(finalData);
        registerOutcome(null, providerName);
      }
      return; 

    } catch (error) {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      lastError = error;
      const status = error.response?.status;
      const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
      const isNetwork = error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED';

      console.warn(
        `[Router] ❌ Помилка на ${actualModelPath}:`,
        status ? `HTTP ${status}` : error.code ?? error.message,
        isTimeout ? '(таймаут з\'єднання)' : '',
        isNetwork ? '(мережева помилка)' : ''
      );

      // 400 — невалідний запит, повторювати на іншій моделі марно.
      // 401 більше НЕ обриває ланцюжок: ключі вже перебрані вище, тож має сенс
      // спробувати іншого провайдера з власним ключем.
      if (status === 400) break;
      // Клієнт сам відключився — далі пробувати немає сенсу
      if (clientGone) break;
      // Таймаут при стрімі — пробуємо наступну модель
      // (інші помилки теж продовжують chain)
    }
  }
  // Клієнт відключився ще до відповіді — нема кому відповідати і нема що рахувати
  if (clientGone) {
    console.log('[Router] 🚫 Клієнт відключився, результат не зараховуємо');
    return;
  }

  handleError(lastError || new Error("Всі моделі в ланцюжку недоступні"), res, lastProviderName);
});

module.exports = router;
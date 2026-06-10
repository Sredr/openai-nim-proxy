const express = require('express');
const axios = require('axios');
const router = express.Router();
const providersConfig = require('../../config/providers.json');
const routerConfig = require('../../config/router.json');
const adapters = require('../adapters');
const { extractApiKey, handleError, trackEndpoint, trackProvider, stats, config } = require('../utils/helpers');

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
  
  const requestedAlias = req.body.model || 'default';
  const modelChain = resolveModelChain(requestedAlias);

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
      const apiKey = extractApiKey(req, providerName);

      if (!apiKey) { 
        console.warn(`[Router] ⚠️ Не знайдено API ключ для провайдера: ${providerName}. Пропускаю модель ${pureModelName}`); 
        continue; 
      }
      
      if (apiKey === 'nvapi-') {
        console.warn(`[Router] ⚠️ API ключ для ${providerName} є пустим (nvapi-). Пропускаю.`);
        continue;
      }
      
      trackProvider(providerName);
      console.log(`[Router] ➡️ Направляю на: ${providerName} | Модель: ${pureModelName} | stream=${isStream}`);

      const adapter = adapters[provider.type] || adapters.openai;
      const requestBody = adapter.formatReq(req.body, pureModelName);

      if (config.enableThinking && providerName === 'nvidia') {
        requestBody.extra_body = { chat_template_kwargs: { thinking: true } };
      }

      let reqUrl = `${provider.baseUrl}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };

      if (provider.type === 'gemini') {
        reqUrl = `${provider.baseUrl}/${pureModelName}:generateContent?key=${apiKey}`;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

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

      const response = await axios({
        method: 'post',
        url: reqUrl,
        data: requestBody,
        headers,
        responseType: isStream ? 'stream' : 'json',
        timeout: connectTimeoutMs,
      });

      stats.success++;
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
        });

        response.data.on('error', (streamErr) => {
          clearInterval(keepaliveTimer);
          console.error(`[Router] ❌ Помилка стріму від ${actualModelPath}:`, streamErr.message);
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

      // 400/401 — не пробуємо далі (неправильний запит або ключ)
      if (status === 400 || status === 401) break;
      // Таймаут при стрімі — пробуємо наступну модель
      // (інші помилки теж продовжують chain)
    }
  }
  handleError(lastError || new Error("Всі моделі в ланцюжку недоступні"), res);
});

module.exports = router;

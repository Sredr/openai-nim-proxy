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
  if (res.flush) res.flush();
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
      console.log(`[Router] ➡️ Направляю на: ${providerName} | Чиста модель: ${pureModelName}`);

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

      const response = await axios({
        method: 'post', url: reqUrl, data: requestBody, headers,
        responseType: isStream ? 'stream' : 'json', timeout: config.timeoutMs,
      });

      stats.success++; console.log(`[Router] ✅ Успішна відповідь від: ${actualModelPath}`);

      if (isStream) {
        setStreamHeaders(res); // ← виклик централізованої функції з X-Accel-Buffering
        response.data.on('data', chunk => adapter.parseStream(chunk, res, config));
        response.data.on('end', () => res.end());
        response.data.on('error', () => res.end());
      } else {
        const finalData = adapter.formatRes(response.data, config);
        res.json(finalData);
      }
      return; 
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      console.warn(`[Router] ❌ Помилка ${status || 'Network'} на шляху ${actualModelPath}`);
      if (status === 400 || status === 401) break; 
    }
  }
  handleError(lastError || new Error("Всі моделі недоступні"), res);
});

module.exports = router;
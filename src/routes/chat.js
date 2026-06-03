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

router.post('/chat/completions', async (req, res) => {
  stats.total++; trackEndpoint('POST /v1/chat/completions');
  
  const requestedAlias = req.body.model || 'default';
  const modelChain = resolveModelChain(requestedAlias);

  // Санітизація повідомлень
  let sanitizedMessages = [];
  let systemContent = '';
  for (const msg of req.body.messages || []) {
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

  // ─── БАГ 5: stream завжди перевіряємо строго ===, а не truthiness ───
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
      
      trackProvider(providerName);
      console.log(`[Router] ➡️ Направляю на: ${providerName} | Чиста модель: ${pureModelName}`);

      const adapter = adapters[provider.type] || adapters.openai;
      const requestBody = adapter.formatReq(req.body, pureModelName);

      // extra_body тільки для NVIDIA
      if (config.enableThinking && providerName === 'nvidia') {
        requestBody.extra_body = { chat_template_kwargs: { thinking: true } };
      }

      // ─── БАГ 4 ВИПРАВЛЕНО: було const — падало при type === 'gemini' ───
      let reqUrl = `${provider.baseUrl}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };

      if (provider.type === 'gemini') {
        // Нативний Gemini API (якщо додати провайдера з type: "gemini" в providers.json)
        reqUrl = `${provider.baseUrl}/${pureModelName}:generateContent?key=${apiKey}`;
      } else {
        // OpenAI-сумісні провайдери (NVIDIA, Groq, Google через OpenAI compat)
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await axios({
        method: 'post', url: reqUrl, data: requestBody, headers,
        responseType: isStream ? 'stream' : 'json', timeout: config.timeoutMs,
      });

      stats.success++; console.log(`[Router] ✅ Успішна відповідь від: ${actualModelPath}`);

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // ─── БАГ: res.inReasoning — видалено, ніде не використовувалось ───
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
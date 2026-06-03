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

router.post('/completions', async (req, res) => {
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

  if (config.enableThinking) req.body.extra_body = { chat_template_kwargs: { thinking: true } };

  let lastError = null;

  for (const actualModelPath of modelChain) {
    try {
      let providerName = 'nvidia'; 
      let pureModelName = actualModelPath;

      // ─── РОЗУМНИЙ ПАРСИНГ: ВІДРІЗАЄМО ТІЛЬКИ ПРОВАЙДЕРА ───
      if (actualModelPath.includes('/')) {
        const parts = actualModelPath.split('/');
        const firstPart = parts[0].toLowerCase();
        
        // Якщо перше слово (напр. "nvidia" або "google") є в нашому config/providers.json
        if (providersConfig[firstPart]) {
          providerName = firstPart;
          // Відрізаємо ТІЛЬКИ провайдера. 
          // "nvidia/mistralai/mistral..." перетвориться на чисте "mistralai/mistral..."
          pureModelName = parts.slice(1).join('/'); 
        } else {
          // Якщо клієнт прислав "mistralai/mistral..." без префікса "nvidia/"
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

      const reqUrl = `${provider.baseUrl}/chat/completions`;
      const headers = { 
        'Content-Type': 'application/json'
      };
      
      if (provider.type === 'gemini') {
        // Якщо раптом використовуєш старий адаптер Gemini
        reqUrl = `${provider.baseUrl}/${pureModelName}:generateContent?key=${apiKey}`;
      } else {
        // Для OpenAI-сумісних (NVIDIA, Groq, новий Google)
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await axios({
        method: 'post', url: reqUrl, data: requestBody, headers,
        responseType: req.body.stream ? 'stream' : 'json', timeout: config.timeoutMs,
      });

      stats.success++; console.log(`[Router] ✅ Успішна відповідь від: ${actualModelPath}`);

      if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.inReasoning = false;
        response.data.on('data', chunk => adapter.parseStream(chunk, res, config));
        response.data.on('end', () => res.end());
        response.data.on('error', () => res.end());
      } else {
        const finalData = adapter.formatRes(response.data);
        if (provider.type === 'openai') {
          for (const choice of finalData.choices ?? []) {
            if (choice.message?.reasoning_content && config.showReasoning) {
              choice.message.content = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${choice.message.content ?? ''}`;
              delete choice.message.reasoning_content;
            }
          }
        }
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

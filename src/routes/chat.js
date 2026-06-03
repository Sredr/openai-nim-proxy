const express = require('express');
const axios = require('axios');
const router = express.Router();
const providersConfig = require('../../config/providers.json');
const routerConfig = require('../../config/router.json');
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

  // Санітизація повідомлень (твоя оригінальна логіка)
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

      // Розумний розбір префіксів
      if (actualModelPath.includes('/')) {
        const parts = actualModelPath.split('/');
        const possibleProvider = parts[0].toLowerCase();
        
        if (providersConfig[possibleProvider]) {
          providerName = possibleProvider;
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

      // Будуємо тіло запиту
      const nimBody = {
        ...req.body,
        model: pureModelName
      };

      const reqUrl = `${provider.baseUrl}/chat/completions`;
      const headers = { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };

      const response = await axios({
        method: 'post', 
        url: reqUrl, 
        data: nimBody, 
        headers,
        responseType: req.body.stream ? 'stream' : 'json', 
        timeout: config.timeoutMs,
      });

      stats.success++; console.log(`[Router] ✅ Успішна відповідь від: ${actualModelPath}`);

      if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        let buffer = '', inReasoning = false;
        
        response.data.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            if (t === 'data: [DONE]') { res.write('data: [DONE]\n\n'); continue; }
            if (!t.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(t.slice(6));
              const delta = data.choices?.[0]?.delta;
              if (delta) {
                const rc = delta.reasoning_content, c = delta.content;
                if (config.showReasoning) {
                  let out = '';
                  if (rc && !inReasoning) { out = '<think>\n' + rc; inReasoning = true; }
                  else if (rc) out = rc;
                  if (c && inReasoning) { out += '\n</think>\n\n' + c; inReasoning = false; }
                  else if (c) out += c;
                  delta.content = out || '';
                } else {
                  if (rc && !c) continue;
                  delta.content = c ?? '';
                }
                delete delta.reasoning_content;
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch {}
          }
        });
        
        response.data.on('end', () => res.end());
        response.data.on('error', () => res.end());
      } else {
        const data = response.data;
        for (const choice of data.choices ?? []) {
          const msg = choice.message;
          if (!msg) continue;
          if (config.showReasoning && msg.reasoning_content)
            msg.content = `<think>\n${msg.reasoning_content}\n</think>\n\n${msg.content ?? ''}`;
          delete msg.reasoning_content;
        }
        res.json(data);
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

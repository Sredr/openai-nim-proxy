const { StringDecoder } = require('string_decoder');

// ── SSE Line Buffer ──────────────────────────────────────────────────────────
// Проблема 1 (швидкість): Axios нарізає upstream-відповідь на довільні TCP chunks.
// Один SSE-рядок "data: {...}\n\n" може прийти як кілька окремих data-events.
// Стара логіка: split('\n') на кожен chunk → неповні рядки ігнорувались.
// Нова логіка: буфер накопичує текст і обробляє тільки повні \n\n-події.
//
// Проблема 2 (знаки питання): Кирилиця = 2 байти на символ, emoji = 4 байти.
// Якщо TCP chunk обрізає символ посередині, chunk.toString() → "?" або "▯".
// StringDecoder утримує неповні байти між chunks і додає їх до наступного.
// Приклад: "і" = [0xD1, 0x96]. Chunk закінчується на 0xD1 →
//   chunk.toString()        → "?"           (ПОГАНО)
//   decoder.write(chunk)    → ""            (затримали 0xD1)
//   decoder.write(nextChunk)→ "і..."        (ДОБРЕ, 0xD1+0x96 = повний символ)

function extractThoughtTags(text) {
  const match = text.match(/^<thought>[\s\S]*?<\/thought>/);
  if (!match) return { thought: null, content: text };
  return {
    thought: match[0].replace(/<\/?thought>/g, '').trim(),
    content: text.slice(match[0].length).trim()
  };
}

function cleanResponse(data, config) {
  if (!data?.choices) return data;
  for (const choice of data.choices) {
    if (choice.message) {
      delete choice.message.extra_content;
      delete choice.message.thinking_blocks;
      delete choice.message.images;
      delete choice.message.vertex_ai_grounding_metadata;
      delete choice.message.vertex_ai_url_context_metadata;
      delete choice.message.vertex_ai_safety_results;
      delete choice.message.vertex_ai_citation_metadata;

      const { thought, content } = extractThoughtTags(choice.message.content || '');

      if (config?.showReasoning) {
        if (thought) {
          choice.message.reasoning_content = thought;
          choice.message.content = content || null;
        }
      } else {
        delete choice.message.reasoning_content;
        choice.message.content = content || thought || '';
      }
    }
  }
  delete data.extra_content;
  return data;
}

// Обробляє один повний SSE-рядок (вже без "data: " префіксу і \n\n).
// State machine для <thought> тегів — стан зберігається в res.isThinking.
function processSseLine(jsonStr, res, config) {
  if (jsonStr === '[DONE]') {
    res.write('data: [DONE]\n\n');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return;
  }

  const delta = parsed.choices?.[0]?.delta;

  if (!delta || delta.content == null) {
    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    return;
  }

  let content = String(delta.content || '');
  if (res.isThinking === undefined) res.isThinking = false;

  while (content.length > 0) {
    if (!res.isThinking) {
      const startIdx = content.indexOf('<thought>');
      if (startIdx === -1) {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content, role: 'assistant' }, index: 0 }]
        })}\n\n`);
        content = '';
      } else {
        const before = content.slice(0, startIdx);
        if (before) {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: before, role: 'assistant' }, index: 0 }]
          })}\n\n`);
        }
        content = content.slice(startIdx + '<thought>'.length);
        res.isThinking = true;
      }
    } else {
      const endIdx = content.indexOf('</thought>');
      if (endIdx === -1) {
        if (config.showReasoning) {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: content, role: 'assistant' }, index: 0 }]
          })}\n\n`);
        }
        content = '';
      } else {
        const thought = content.slice(0, endIdx);
        if (config.showReasoning && thought) {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: thought, role: 'assistant' }, index: 0 }]
          })}\n\n`);
        }
        content = content.slice(endIdx + '</thought>'.length);
        res.isThinking = false;
      }
    }
  }
}

module.exports = {
  formatReq: (body, model) => ({ ...body, model }),
  formatRes: (data, config) => cleanResponse(data, config),

  parseStream: (chunk, res, config) => {
    if (res._sseBuffer === undefined) {
      res._sseBuffer = '';
      // StringDecoder буферизує неповні multi-byte UTF-8 між chunks
      res._sseDecoder = new StringDecoder('utf8');
    }

    // decoder.write() повертає тільки повні UTF-8 символи,
    // неповний хвіст тримає всередині до наступного chunk
    res._sseBuffer += res._sseDecoder.write(chunk);

    const events = res._sseBuffer.split('\n\n');
    // Останній елемент — або '' або неповний рядок, залишаємо в буфері
    res._sseBuffer = events.pop() ?? '';

    for (const event of events) {
      for (const line of event.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data: ')) {
          processSseLine(t.slice(6), res, config);
        }
      }
    }
  },

  // Викликається з chat.js в 'end' handler.
  // Деякі провайдери не закінчують останній рядок на \n\n —
  // без цього [DONE] або останній токен губиться.
  flushBuffer: (res, config) => {
    if (res._sseBuffer === undefined) return;
    // decoder.end() повертає будь-які байти що залишились всередині decoder
    const tail = res._sseDecoder ? res._sseDecoder.end() : '';
    const remaining = (res._sseBuffer + tail).trim();
    res._sseBuffer = '';
    if (!remaining) return;

    for (const line of remaining.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data: ')) {
        processSseLine(t.slice(6), res, config);
      }
    }
  }
};

// ── SSE Line Buffer ──────────────────────────────────────────────────────────
// Проблема: Axios (і будь-який TCP стек) нарізає upstream-відповідь на довільні
// шматки (~256–4096 байт). Один SSE-рядок "data: {...}\n\n" може прийти як:
//   chunk1: 'data: {"choices":[{"delta":{"con'
//   chunk2: 'tent":"Hello world"}}]}\n\n'
// Стара логіка робила split('\n') на кожен chunk і намагалась парсити неповні
// рядки — вони або ігнорувались, або давали помилку JSON.parse.
//
// Рішення: SSE-буфер накопичує сирий текст і відпрацьовує тільки ПОВНІ події
// (рядки до \n\n). Неповні залишаються в буфері до наступного chunk.
//
// ВАЖЛИВО про flush():
// res.flush() — це метод compression-middleware (наприклад, express-compression).
// Без compression middleware — його взагалі немає (res.flush === undefined).
// Навіть якщо є — викликати його після кожного write() контрпродуктивно:
// Node.js і так надсилає write() без затримок (Nagle disabled for HTTP responses).
// Частий flush() лише додає syscall overhead і збільшує кількість TCP-пакетів.
// Ми його прибрали повністю.

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
    // Неповалідний JSON — пропускаємо (upstream іноді надсилає comment-рядки)
    return;
  }

  const delta = parsed.choices?.[0]?.delta;

  // Якщо немає delta або немає content — пропускаємо або форвардимо як є
  if (!delta || delta.content == null) {
    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    return;
  }

  let content = String(delta.content || '');
  if (res.isThinking === undefined) res.isThinking = false;

  // State machine для <thought>...</thought> тегів (thinking моделі NIM)
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

  // parseStream викликається з chat.js на кожен TCP chunk від upstream.
  // Ми НЕ парсимо chunk одразу — накопичуємо в res._sseBuffer до повного рядка.
  parseStream: (chunk, res, config) => {
    // Ініціалізація буфера на перший виклик
    if (res._sseBuffer === undefined) res._sseBuffer = '';

    res._sseBuffer += chunk.toString();

    // SSE-події розділяються подвійним переносом рядка \n\n
    // Розбиваємо буфер на повні події
    const events = res._sseBuffer.split('\n\n');

    // Останній елемент після split — або пустий рядок (якщо chunk закінчувався на \n\n)
    // або неповний рядок що чекає на продовження. Залишаємо в буфері.
    res._sseBuffer = events.pop() ?? '';

    for (const event of events) {
      // Кожна подія може складатись з кількох рядків (multi-line SSE).
      // Нас цікавлять тільки рядки "data: ..."
      for (const line of event.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data: ')) {
          processSseLine(t.slice(6), res, config);
        }
        // Рядки типу "event: ...", ": comment" — ігноруємо
      }
    }
  }
};

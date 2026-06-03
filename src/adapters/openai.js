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

module.exports = {
  formatReq: (body, model) => ({ ...body, model }),
  formatRes: (data, config) => cleanResponse(data, config),
  parseStream: (data, res, config) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;

      // ─── БАГ 1 ВИПРАВЛЕНО: було 'data:' — ніколи не матчило реальний [DONE] ───
      if (t === 'data: [DONE]') {
        // Скидаємо залишок буферу якщо є
        const remaining = res.thoughtBuf || '';
        if (remaining.trim()) {
          if (config.showReasoning && !res.thoughtFlushed) {
            const thought = remaining.replace(/<\/?thought>/g, '').trim();
            if (thought) {
              res.thoughtFlushed = true;
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thought, role: 'assistant' }, finish_reason: 'stop', index: 0 }] })}\n\n`);
            }
          } else if (!config.showReasoning) {
            // Викидаємо незакриті thought-теги, відправляємо решту як content
            const clean = remaining.replace(/<thought>[\s\S]*$/g, '').trim();
            if (clean) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: clean, role: 'assistant' }, index: 0 }] })}\n\n`);
            }
          }
        }
        res.thoughtBuf = '';
        res.write('data: [DONE]\n\n');
        continue;
      }

      if (!t.startsWith('data: ')) continue;

      try {
        const parsed = JSON.parse(t.slice(6));
        const delta = parsed.choices?.[0]?.delta;

        if (!delta) {
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        delete delta.extra_content;
        const c = delta.content;

        // Upstream вже повертає reasoning_content — пропускаємо наскрізь
        if (delta.reasoning_content) {
          if (config.showReasoning) res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        // Чанк без content (finish_reason тощо) — відправляємо як є
        if (c == null) {
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        // ─── Логіка обробки <thought> тегів ───
        if (!res.thoughtBuf) res.thoughtBuf = '';
        res.thoughtBuf += c;

        const thoughtStart = res.thoughtBuf.indexOf('<thought>');
        const thoughtEnd   = res.thoughtBuf.indexOf('</thought>');

        // Знайдено повний блок <thought>...</thought>
        if (thoughtStart !== -1 && thoughtEnd !== -1) {
          const before  = res.thoughtBuf.slice(0, thoughtStart);
          const thought  = res.thoughtBuf.slice(thoughtStart + '<thought>'.length, thoughtEnd).trim();
          const after    = res.thoughtBuf.slice(thoughtEnd + '</thought>'.length);
          res.thoughtBuf = '';

          if (config.showReasoning) {
            if (before) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: before, role: 'assistant' }, index: 0 }] })}\n\n`);
            if (thought && !res.thoughtFlushed) {
              res.thoughtFlushed = true;
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thought, role: 'assistant' }, index: 0 }] })}\n\n`);
            }
            if (after) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: after, role: 'assistant' }, index: 0 }] })}\n\n`);
          } else {
            // Викидаємо thought, відправляємо тільки до і після
            const toSend = before + after;
            if (toSend) {
              delete delta.reasoning_content;
              delta.content = toSend;
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            }
          }
          continue;
        }

        // <thought> відкрито, але ще не закрито — продовжуємо буферизувати
        if (thoughtStart !== -1 && thoughtEnd === -1) {
          continue;
        }

        // ─── БАГ 2+3 ВИПРАВЛЕНО: без тегів — відправляємо одразу і чистимо буфер ───
        // Раніше: continue без відправки (showReasoning=true) або буфер ніколи не очищувався
        const toSend = res.thoughtBuf;
        res.thoughtBuf = '';
        delete delta.reasoning_content;
        delta.content = toSend;
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);

      } catch { /* пропускаємо некоректні рядки */ }
    }
  }
};
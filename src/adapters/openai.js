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

      if (config?.showReasoning) {
        const { thought, content } = extractThoughtTags(choice.message.content || '');
        if (thought) {
          choice.message.reasoning_content = thought;
          choice.message.content = content;
        }
      } else {
        delete choice.message.reasoning_content;
        if (choice.message.content) {
          const { content } = extractThoughtTags(choice.message.content);
          choice.message.content = content;
        }
      }
    }
  }
  delete data.extra_content;
  return data;
}

function parseStream(data, res, config) {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'data: [DONE]') { res.write('data: [DONE]\n\n'); continue; }
    if (!t.startsWith('data: ')) continue;
    try {
      const parsed = JSON.parse(t.slice(6));
      const delta = parsed.choices?.[0]?.delta;
      if (delta) {
        delete delta.extra_content;
        const c = delta.content;

        if (config.showReasoning) {
          // Збираємо chunk в буфер, шукаємо <thought>
          if (!res.thoughtBuf) res.thoughtBuf = '';
          if (c) res.thoughtBuf += c;

          const thoughtEnd = res.thoughtBuf.indexOf('</thought>');
          if (thoughtEnd !== -1) {
            // Є закритий тег — витягуємо думки
            const before = res.thoughtBuf.slice(0, thoughtEnd);
            const thought = before.replace(/<thought>/g, '').trim();
            const after = res.thoughtBuf.slice(thoughtEnd + '</thought>'.length);
            
            if (thought) {
              res.write(`data: ${JSON.stringify({ ...parsed, choices: [{ ...parsed.choices[0], delta: { reasoning_content: thought, role: 'assistant' } }] })}\n\n`);
            }
            if (after) {
              res.write(`data: ${JSON.stringify({ ...parsed, choices: [{ ...parsed.choices[0], delta: { content: after, role: 'assistant' } }] })}\n\n`);
            }
            res.thoughtBuf = '';
            continue;
          }

          if (res.thoughtBuf.includes('<thought>') && !res.thoughtBuf.includes('</thought>')) {
            // Ще не закрили — буферизуємо
            continue;
          }

          // Звичайний контент
          if (c) {
            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          }
        } else {
          if (!config.showReasoning) {
            if (c && c.includes('<thought>')) {
              // showReasoning=false: прибираємо <thought> блоки
              if (!res.thoughtBuf) res.thoughtBuf = '';
              res.thoughtBuf += c;
              const thoughtEnd = res.thoughtBuf.indexOf('</thought>');
              if (thoughtEnd !== -1) {
                const after = res.thoughtBuf.slice(thoughtEnd + '</thought>'.length);
                if (after) {
                  delta.content = after;
                  res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                }
                res.thoughtBuf = '';
              }
              continue;
            }
            delete delta.reasoning_content;
            delta.content = c ?? '';
          }
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        }
      } else {
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      }
    } catch {}
  }
}

module.exports = {
  formatReq: (body, model) => ({ ...body, model }),
  formatRes: (data, config) => cleanResponse(data, config),
  parseStream,
};
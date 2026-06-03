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
      if (t === 'data: [DONE]') { res.write('data: [DONE]\n\n'); continue; }
      if (!t.startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(t.slice(6));
        const delta = parsed.choices?.[0]?.delta;
        if (delta) {
          delete delta.extra_content;
          const c = delta.content;

          if (config.showReasoning) {
            // reasoning_content від upstream (LiteLLM-like) — пропускаємо наскрізь
            if (delta.reasoning_content) {
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
              continue;
            }

            // Буферизуємо content, шукаємо <thought> теги
            if (c) {
              if (!res.thoughtBuf) res.thoughtBuf = '';
              res.thoughtBuf += c;

              const thoughtEnd = res.thoughtBuf.indexOf('</thought>');
              if (thoughtEnd !== -1) {
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
                continue;
              }
            }

            // Чанки без content (finish_reason, usage) — пишемо
            if (!c && parsed.choices?.[0]?.finish_reason) {
              if (res.thoughtBuf) {
                res.write(`data: ${JSON.stringify({ ...parsed, choices: [{ ...parsed.choices[0], delta: { reasoning_content: res.thoughtBuf.replace(/<thought>/g, '').trim(), role: 'assistant' }, finish_reason: parsed.choices[0].finish_reason }] })}\n\n`);
                res.thoughtBuf = '';
              } else {
                res.write(`data: ${JSON.stringify(parsed)}\n\n`);
              }
              continue;
            }
            // Звичайний content без думок — пишемо
            if (c) {
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            }
          } else {
            // showReasoning=false
            if (c) {
              if (!res.thoughtBuf) res.thoughtBuf = '';
              res.thoughtBuf += c;

              const thoughtEnd = res.thoughtBuf.indexOf('</thought>');
              if (thoughtEnd !== -1) {
                const after = res.thoughtBuf.slice(thoughtEnd + '</thought>'.length);
                if (after) {
                  delta.content = after;
                  res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                } else {
                  const before = res.thoughtBuf.slice(0, thoughtEnd).replace(/<thought>/g, '').trim();
                  if (before) {
                    delta.content = before;
                    res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                  }
                }
                res.thoughtBuf = '';
                continue;
              }

              if (res.thoughtBuf.includes('<thought>') && !res.thoughtBuf.includes('</thought>')) {
                continue;
              }

              delete delta.reasoning_content;
              delta.content = c ?? '';
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } else {
              // empty delta (finish_reason etc) — write as-is
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            }
          }
        } else {
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        }
      } catch {}
    }
  }
};
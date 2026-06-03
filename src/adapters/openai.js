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

      if (t === 'data: [DONE]') {
        res.write('data: [DONE]\n\n');
        continue;
      }

      if (!t.startsWith('data: ')) continue;

        try {
          const parsed = JSON.parse(t.slice(6));
          const delta = parsed.choices?.[0]?.delta;

          if (!delta || delta.content == null) {
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          continue;
        }

        let content = String(delta.content || '');
        
        // State Machine для миттєвого стрімінгу без затримок
        if (res.isThinking === undefined) res.isThinking = false;

        while (content.length > 0) {
          if (!res.isThinking) {
            const startIdx = content.indexOf('<thought>');
            if (startIdx === -1) {
              // Звичайний текст, відправляємо одразу
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content, role: 'assistant' }, index: 0 }] })}\n\n`);
              if (res.flush) res.flush();
              content = '';
            } else {
              // Відправляємо текст ДО тегу, перемикаємось в режим reasoning
              const before = content.slice(0, startIdx);
              if (before) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: before, role: 'assistant' }, index: 0 }] })}\n\n`);
                if (res.flush) res.flush();
              }
              content = content.slice(startIdx + '<thought>'.length);
              res.isThinking = true;
            }
          } else {
            const endIdx = content.indexOf('</thought>');
            if (endIdx === -1) {
              // Ми все ще в блоці думок, стрімимо як reasoning_content
              if (config.showReasoning) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: content, role: 'assistant' }, index: 0 }] })}\n\n`);
                if (res.flush) res.flush();
              }
              content = '';
            } else {
              // Думки закінчились, відправляємо останній шматок думок і перемикаємось
              const thought = content.slice(0, endIdx);
              if (config.showReasoning && thought) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thought, role: 'assistant' }, index: 0 }] })}\n\n`);
                if (res.flush) res.flush();
              }
              content = content.slice(endIdx + '</thought>'.length);
              res.isThinking = false;
            }
          }
        }
      } catch { /* ignore malformed JSON */ }
    }
  }
};
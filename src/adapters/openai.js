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
          const rc = delta.reasoning_content;
          const c = delta.content;

          if (!config.showReasoning) {
            delete delta.reasoning_content;
            if (rc && !c) continue;
            delta.content = c ?? '';
          }
          delete delta.extra_content;
        }
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch {}
    }
  }
};
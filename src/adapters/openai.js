function stripThoughtTags(text) {
  return text.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
}

function cleanResponse(data, config) {
  if (!data?.choices) return data;
  for (const choice of data.choices) {
    if (choice.message) {
      delete choice.message.extra_content;
      
      if (!config?.showReasoning) {
        delete choice.message.reasoning_content;
        if (choice.message.content) {
          choice.message.content = stripThoughtTags(choice.message.content);
        }
      } else {
        delete choice.message.reasoning_content;
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
          const rc = delta.reasoning_content, c = delta.content;
          if (config.showReasoning) {
            let out = '';
            if (rc && !res.inReasoning) { out = '<think>\n' + rc; res.inReasoning = true; }
            else if (rc) out = rc;
            if (c && res.inReasoning) { out += '\n</think>\n\n' + c; res.inReasoning = false; }
            else if (c) out += c;
            delta.content = out || '';
          } else {
            if (rc && !c) continue;
            delta.content = c ?? '';
          }
          delete delta.reasoning_content;
        }
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch {}
    }
  }
};
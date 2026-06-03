module.exports = {
  formatReq: (body) => {
    const contents = (body.messages || []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    return {
      contents,
      generationConfig: { temperature: body.temperature, maxOutputTokens: body.max_tokens }
    };
  },
  formatRes: (data) => {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return {
      id: 'chatcmpl-gemini',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
    };
  },
  parseStream: (data, res) => {
    // Базовий пасстру для стрімів Gemini (потребуватиме розширення для ідеальної конвертації)
    res.write(data.toString());
  }
};
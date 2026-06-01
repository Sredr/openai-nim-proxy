// server.js - OpenAI → NVIDIA NIM Proxy (pass-through mode)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI → NVIDIA NIM Proxy' });
});

// ─── Models list (stub — Janitor AI просто перевіряє що ендпоінт є) ────────
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: 'nvidia-nim-passthrough', object: 'model', created: Date.now(), owned_by: 'nvidia' }]
  });
});

// ─── Main proxy ────────────────────────────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
  // 1. Беремо ключ з Authorization заголовку (Janitor AI сам туди кладе те, що ти вводиш)
  const authHeader = req.headers['authorization'] ?? '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!apiKey) {
    return res.status(401).json({
      error: { message: 'Missing API key in Authorization header', type: 'auth_error', code: 401 }
    });
  }

  // 2. Модель — як є з запиту, без маппінгу
  const { model, messages, temperature, max_tokens, stream } = req.body;

  if (!model || !messages) {
    return res.status(400).json({
      error: { message: 'Fields "model" and "messages" are required', type: 'invalid_request_error', code: 400 }
    });
  }

  const nimRequest = {
    model,
    messages,
    temperature: temperature ?? 0.6,
    max_tokens: max_tokens ?? 2048,
    stream: stream ?? false
  };

  try {
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120_000 // 2 хв — для повільних моделей
    });

    // ── Streaming ──────────────────────────────────────────────────────────
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';

      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Залишаємо незавершений рядок у буфері

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Безпечна перевірка [DONE] — тільки в data-рядку
          if (trimmed === 'data: [DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta;

            if (delta) {
              // Якщо модель повертає reasoning_content без content — пропускаємо чанк
              // (щоб не слати порожні дельти, які ламають деякі клієнти)
              if (delta.reasoning_content && !delta.content) {
                continue;
              }
              // Прибираємо reasoning_content — клієнт його не розуміє
              delete delta.reasoning_content;
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {
            // Якщо рядок не парситься — пропускаємо, не крашимось
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', err => {
        console.error('Stream error:', err.message);
        res.end();
      });

    // ── Non-streaming ──────────────────────────────────────────────────────
    } else {
      const data = response.data;

      // Прибираємо reasoning_content з відповіді (якщо є)
      if (data.choices) {
        for (const choice of data.choices) {
          if (choice.message?.reasoning_content) {
            delete choice.message.reasoning_content;
          }
        }
      }

      res.json(data);
    }

  } catch (err) {
    const status = err.response?.status || 500;
    // NVIDIA повертає помилки і в .message, і в .detail
    const message =
      err.response?.data?.detail ||
      err.response?.data?.error?.message ||
      err.message ||
      'Proxy error';

    console.error(`[${status}] ${message}`);
    res.status(status).json({ error: { message, type: 'proxy_error', code: status } });
  }
});

// ─── Fallback ──────────────────────────────────────────────────────────────
app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not supported`, code: 404 } });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});

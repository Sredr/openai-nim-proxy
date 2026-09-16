// ── Фейковий upstream для тестів надійності ─────────────────────────────────
// Мінімальний HTTP-сервер, який вдає провайдера моделей. Дозволяє:
//   • віддавати сценарій відповідей (200 / 429 / 500 / обірваний стрім)
//   • задавати сценарій ОКРЕМО для кожного ключа (щоб тестувати перемикання)
//   • записувати всі виклики разом із ключем, який прислав проксі
//
// Використання:
//   const { startFakeUpstream } = require('./fake-upstream');
//   const up = await startFakeUpstream({
//     defaultScript: [429, 200],
//     keyScripts: { 'bad': [401, 401], 'slow': ['stream-abort'] },
//   });
//   console.log(up.port, up.calls);
const http = require('http');

function startFakeUpstream(options = {}) {
  const defaultScript = options.defaultScript ?? [200];
  const keyScripts = options.keyScripts ?? {};   // префікс ключа → масив кроків
  const calls = [];
  const cursor = new Map();                      // ключ → скільки разів уже викликали

  const scriptForKey = (key) => {
    for (const [prefix, script] of Object.entries(keyScripts)) {
      if (key.startsWith(prefix)) return script;
    }
    return defaultScript;
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const auth = req.headers['authorization'] ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      calls.push({ method: req.method, url: req.url, key, body });

      const script = scriptForKey(key);
      const seen = cursor.get(key) ?? 0;
      cursor.set(key, seen + 1);
      // Коли сценарій вичерпано — повторюємо його останній крок
      const step = script[Math.min(seen, script.length - 1)];

      if (step === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok-from-' + key.slice(0, 8) }, finish_reason: 'stop' }],
        }));
        return;
      }

      // Стрім, який обривається посеред відповіді — типова поведінка
      // перевантаженого провайдера. Проксі має зарахувати це як ПОМИЛКУ.
      // Content-Length більший за фактично надіслане тіло — так клієнт гарантовано
      // бачить обірвану відповідь, а не «успішний» короткий стрім.
      if (step === 'stream-abort') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Content-Length': '512',
        });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        setTimeout(() => res.socket.destroy(), 20);
        return;
      }

      // Успішний SSE-стрім — основний продовий шлях (перевіряємо, що після
      // змін у фіксації результату він досі доходить до клієнта повністю)
      if (step === 'stream-ok') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":"hello"}}]}\n\n');
        setTimeout(() => {
          res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }, 30);
        return;
      }

      // Числовий крок = HTTP-статус помилки
      const headers = { 'Content-Type': 'application/json' };
      if (step === 429) headers['Retry-After'] = options.retryAfter ?? '0';
      res.writeHead(step, headers);
      res.end(JSON.stringify({ error: { message: 'fake upstream ' + step } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        calls,
        // Скільки разів цей ключ реально пішов в upstream
        countFor: (prefix) => calls.filter(c => c.key.startsWith(prefix)).length,
        // Проксі тримає keep-alive з'єднання, тому звичайний close() чекає на них
        // вічно — спершу примусово закриваємо всі сокети.
        close: () => new Promise(r => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(r);
        }),
      });
    });
  });
}

module.exports = { startFakeUpstream };

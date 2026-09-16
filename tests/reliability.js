// ── Тести надійності проксі ─────────────────────────────────────────────────
// Перевіряють те, на що скаржився власник у проді:
//   1) проксі БАЧИТЬ помилки (429/5xx/таймаути потрапляють у статистику)
//   2) проксі ПОВТОРЮЄ запит (429 з Retry-After, 5xx з backoff)
//   3) проксі ПЕРЕМИКАЄ ключ, коли поточний віддав 429/401
//   4) метрики сходяться: total = success + failed, сума err* = failed
//
// Запуск: node tests/reliability.js
const { spawn } = require('child_process');
const http = require('http');
const { startFakeUpstream } = require('./fake-upstream');

const TEST_PORT = 3002;

function request(method, path, body, headers) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method, headers: headers || {} },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
        // Обірване з'єднання — теж валідний результат для тестів стрімінгу
        res.on('aborted', () => resolve({ status: res.statusCode, body: data, aborted: true }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, body: '', aborted: true, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

const chat = (model, extraHeaders = {}, extraBody = {}) =>
  request('POST', '/v1/chat/completions',
    JSON.stringify({ model, messages: [{ role: 'user', content: 'привіт' }], ...extraBody }),
    { 'Content-Type': 'application/json', ...extraHeaders });

const getStats = async () => JSON.parse((await request('GET', '/admin/stats')).body);

function startServer(env) {
  return new Promise((resolve, reject) => {
    console.log('[Test] Starting proxy server...');
    const proc = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
    });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });

    const poll = setInterval(() => {
      if (output.includes(`порту ${TEST_PORT}`)) {
        clearInterval(poll);
        console.log('[Test] Proxy ready.\n');
        resolve(proc);
      }
    }, 150);

    setTimeout(() => {
      clearInterval(poll);
      proc.kill();
      reject(new Error('Проксі не стартував за 10с. Вивід:\n' + output.slice(-600)));
    }, 10000);
  });
}

(async () => {
  const upstream = await startFakeUpstream({
    defaultScript: [200],
    retryAfter: '0',
    keyScripts: {
      badkey: [429],            // ключ, який завжди ловить 429
      goodkey: [200],           // ключ, який працює
      'slow-key': ['stream-abort'],
      'stream-key': ['stream-ok'],
      flaky: [429, 200],        // 429 → круг → 200
      broken: [503],            // 5xx назавжди
      bad1key: [429],           // обидва ключі під 429 — перевірка кругів
      bad2key: [429],
      onekey: [429],            // єдиний ключ під 429 — 3 круги = 3 спроби
      rotA: [200],              // ротація ключів між запитами
      rotB: [200],
    },
  });

  const server = await startServer({
    PORT: TEST_PORT,
    TEST_UPSTREAM_BASE: upstream.baseUrl,
    NVIDIA_API_KEYS: 'env-nvidia-key-000001',   // тільки для тесту невідомого провайдера
    // Для google env-ключі ЯВНО порожні ('' перекриває значення з реального .env):
    // інакше ключ із .env став би третім кандидатом і «рятував» запит після 429,
    // заважаючи точно перевірити круги по ключах
    GOOGLE_API_KEY: '',
    GOOGLE_API_KEYS: '',
    MAX_RETRIES: '1',
    RETRY_DELAY_MS: '20',
    MAX_429_RETRIES: '3',            // 3 круги по ключах
    RETRY_429_DELAY_MS: '50',        // пауза МІЖ КРУГАМИ (між ключами — 0)
    RETRY_429_MAX_WAIT_MS: '250',    // сумарний бюджет очікування
    KEY_BAN_MS: '60000',
    MAX_KEY_ATTEMPTS: '3',
    TIMEOUT_MS: '5000',
    STREAM_CONNECT_TIMEOUT_MS: '5000',
  });

  const MODEL = 'google/gemini-2.0-flash';
  const auth = (keys) => ({ Authorization: `Bearer ${keys.join(',')}` });
  const results = [];
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const runCase = async (name, fn) => {
    process.stdout.write(`Running ${name}... `);
    try {
      await fn();
      console.log('✅ PASSED');
      results.push(true);
    } catch (e) {
      console.log(`❌ FAILED: ${e.message}`);
      results.push(false);
    }
  };

  try {
    await runCase('429 -> retry -> 200 (ретрай реально відбувається)', async () => {
      const before = await getStats();
      const res = await chat(MODEL, auth(['flaky-key-00000001']));
      const after = await getStats();

      assert(res.status === 200, `очікували 200, отримали ${res.status}`);
      assert(upstream.countFor('flaky') === 2, `upstream мав отримати 2 спроби, отримав ${upstream.countFor('flaky')}`);
      assert(after.retries >= before.retries + 1, 'stats.retries не зріс — ретраю не було');
      assert(after.retriedOk >= before.retriedOk + 1, 'stats.retriedOk не зріс');
      assert(after.success === before.success + 1, 'успіх не порахований');
      // Головне: 429 видно, навіть якщо ретрай його вилікував
      assert(after.err429 === before.err429 + 1,
        `err429 мав зрости на 1 (429 від upstream), було ${before.err429}, стало ${after.err429}`);
    });

    await runCase('5xx: ретраї вичерпано -> помилка ПОРАХОВАНА', async () => {
      const before = await getStats();
      const res = await chat(MODEL, auth(['broken-key-000001']));
      const after = await getStats();

      assert(res.status === 503, `очікували 503, отримали ${res.status}`);
      assert(upstream.countFor('broken') === 2, `мало бути 2 спроби (1 + ретрай), було ${upstream.countFor('broken')}`);
      // err5xx рахує КОЖНУ помилку від upstream: 2 спроби → +2
      assert(after.err5xx === before.err5xx + 2,
        `err5xx мав зрости на 2 (дві спроби), було ${before.err5xx}, стало ${after.err5xx}`);
      assert(after.failed === before.failed + 1, 'failed мав зрости на 1');
    });

    await runCase('обірваний стрім = помилка, а не успіх', async () => {
      const before = await getStats();
      await chat(MODEL, auth(['slow-key-00000001']), { stream: true });
      await new Promise(r => setTimeout(r, 200));
      const after = await getStats();

      assert(after.success === before.success, 'обірваний стрім зарахували як успіх');
      assert(after.failed === before.failed + 1, 'обірваний стрім не зарахували як помилку');
    });

    await runCase('успішний стрім доходить до клієнта і рахується як успіх', async () => {
      const before = await getStats();
      const res = await chat(MODEL, auth(['stream-key-000001']), { stream: true });
      await new Promise(r => setTimeout(r, 150));
      const after = await getStats();

      assert(res.status === 200, `очікували 200, отримали ${res.status}`);
      assert(res.body.includes('hello') && res.body.includes('world'),
        `стрім не дійшов повністю: ${JSON.stringify(res.body.slice(0, 120))}`);
      assert(res.body.includes('[DONE]'), 'немає завершального [DONE]');
      assert(after.success === before.success + 1, 'успішний стрім не порахований як успіх');
      assert(after.failed === before.failed, 'успішний стрім помилково порахований як невдача');
    });

    await runCase('429: одразу наступний ключ, без паузи між ключами', async () => {
      const mark = upstream.calls.length;
      const res = await chat(MODEL, auth(['badkey-000000001', 'goodkey-00000001']));
      const keysOfRequest = upstream.calls.slice(mark).map(c => c.key);

      assert(res.status === 200, `очікували 200 після перемикання ключа, отримали ${res.status}`);
      assert(keysOfRequest.length === 2, `у першому крузі мало бути рівно 2 виклики, було ${keysOfRequest.length}`);
      assert(keysOfRequest[0].startsWith('badkey') && keysOfRequest[1].startsWith('goodkey'),
        `порядок ключів невірний: ${keysOfRequest.join(' -> ')}`);
    });

    await runCase('круги: обидва ключі під 429 -> 3 круги x 2 ключі = 6 спроб', async () => {
      const mark = upstream.calls.length;
      const res = await chat(MODEL, auth(['bad1key-00000001', 'bad2key-00000001']));
      const calls = upstream.calls.slice(mark);

      assert(res.status === 429, `очікували 429, отримали ${res.status}`);
      assert(calls.length === 6, `3 круги × 2 ключі = 6 спроб, було ${calls.length}`);
      assert(calls[0].key.startsWith('bad1key') && calls[1].key.startsWith('bad2key')
          && calls[2].key.startsWith('bad1key'),
        `ключі мають чергуватись по кругу, а було: ${calls.map(c => c.key.slice(0, 6)).join(' ')}`);
    });

    await runCase('один ключ під 429 -> рівно 3 спроби (3 круги)', async () => {
      const mark = upstream.calls.length;
      const res = await chat(MODEL, auth(['onekey-0000000001']));
      const calls = upstream.calls.slice(mark);

      assert(res.status === 429, `очікували 429, отримали ${res.status}`);
      assert(calls.length === 3, `1 ключ × 3 круги = 3 спроби, було ${calls.length}`);
    });

    await runCase('429 не блокує ключ (це ліміт провайдера, а не проблема ключа)', async () => {
      const mark = upstream.calls.length;
      const res = await chat(MODEL, auth(['onekey-0000000001']));
      const firstKey = upstream.calls[mark]?.key ?? '';

      assert(res.status === 429, `очікували 429, отримали ${res.status}`);
      assert(firstKey.startsWith('onekey'), `ключ після 429 не має блокуватись, а першим пішов "${firstKey}"`);
    });

    await runCase('ротація між запитами: наступний запит починає з іншого ключа', async () => {
      const mark1 = upstream.calls.length;
      await chat(MODEL, auth(['rotA-key-00000001', 'rotB-key-00000001']));
      const first1 = upstream.calls[mark1]?.key ?? '';

      const mark2 = upstream.calls.length;
      await chat(MODEL, auth(['rotA-key-00000001', 'rotB-key-00000001']));
      const first2 = upstream.calls[mark2]?.key ?? '';

      assert(first1.startsWith('rotA'), `перший запит мав почати з rotA, а почав з "${first1}"`);
      assert(first2.startsWith('rotB'), `другий запит має почати з іншого ключа (rotB), а почав з "${first2}"`);
    });

    await runCase('невідомий провайдер: ключ не стає undefined', async () => {
      const mark = upstream.calls.length;
      const res = await chat('brandnew-vendor/some-model', auth(['client-key-0000001']));
      const sentKey = upstream.calls[mark]?.key ?? '';

      assert(res.status === 200, `очікували 200, отримали ${res.status}`);
      assert(sentKey === 'client-key-0000001', `в upstream пішов ключ "${sentKey}" замість надісланого`);
    });

    await runCase('метрики сходяться: total = success + failed, сума err* >= failed', async () => {
      const s = await getStats();
      const sumErr = s.err429 + s.err5xx + s.errOther + s.errTimeout + s.errNetwork;
      const sumKind = Object.values(s.failedByKind ?? {}).reduce((a, b) => a + b, 0);

      assert(s.total === s.success + s.failed,
        `total ${s.total} ≠ success ${s.success} + failed ${s.failed}`);
      assert(sumKind === s.failed, `сума failedByKind ${sumKind} ≠ failed ${s.failed}`);
      assert(sumErr >= s.failed, `сума err* ${sumErr} < failed ${s.failed}`);
      assert(s.err5xx >= 1, 'err5xx має бути > 0 (раніше дашборд показував 0)');
      assert(s.err429 >= 1, 'err429 має бути > 0 (раніше дашборд показував 0)');
      assert(s.retriedOk >= 1, 'має бути хоча б один запит, вилікуваний ретраєм');
    });

  } finally {
    console.log(`\nSummary: ${results.filter(Boolean).length}/${results.length} passed`);
    server.kill();
    await upstream.close();
    process.exit(results.some(ok => !ok) ? 1 : 0);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Запобіжник: тест не має права висіти вічно (keep-alive сокети, що не закрились)
setTimeout(() => {
  console.error('\n[Test] Таймаут 60с — примусове завершення');
  process.exit(1);
}, 60000).unref();

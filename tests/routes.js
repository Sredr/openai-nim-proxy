const { spawn } = require('child_process');
const http = require('http');

const TEST_PORT = 3001;
const BASE_URL = `http://localhost:${TEST_PORT}`;

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers: headers || {},
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    console.log('[Test] Starting server...');
    const serverProcess = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: TEST_PORT },
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    serverProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Чекаємо, поки сервер почне слухати
    const checkInterval = setInterval(() => {
      if (stdout.includes(`порту ${TEST_PORT}`) || stdout.includes(`port ${TEST_PORT}`) || stderr.includes(`порту ${TEST_PORT}`)) {
        clearInterval(checkInterval);
        console.log('[Test] Server started.');
        resolve(serverProcess);
      }
    }, 200);

    // Таймаут 10 секунд
    setTimeout(() => {
      clearInterval(checkInterval);
      serverProcess.kill();
      reject(new Error('Server failed to start within 10s'));
    }, 10000);
  });
}

async function runTests() {
  let serverProcess;
  try {
    serverProcess = await startServer();
  } catch (e) {
    console.error('[Test] Failed to start server:', e.message);
    process.exit(1);
  }

  console.log('=== Routing & Integrity Tests ===\n');
  let passed = 0;
  const tests = [
    {
      name: 'Root 404 Check',
      fn: async () => {
        const res = await request('GET', '/');
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
      },
    },
    {
      name: 'Chat Endpoint with Invalid Model (404)',
      fn: async () => {
        const body = JSON.stringify({
          model: 'nonexistent-model-12345',
          messages: [{ role: 'user', content: 'hi' }],
        });
        const res = await request('POST', '/v1/chat/completions', body, {
          'Content-Type': 'application/json',
        });
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}: ${res.body}`);
      },
    },
    {
      name: 'Invalid Route Check',
      fn: async () => {
        const res = await request('GET', '/v1/invalid-route');
        if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
      },
    },
  ];

  for (const test of tests) {
    process.stdout.write(`Running ${test.name}... `);
    try {
      await test.fn();
      console.log('✅ PASSED');
      passed++;
    } catch (e) {
      console.log(`❌ FAILED: ${e.message}`);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed`);

  console.log('[Test] Stopping server...');
  serverProcess.kill();
  if (passed !== tests.length) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
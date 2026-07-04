const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const PROXY_PORT = 3000;
const LITELLM_PORT = 4000;

// Генеруємо великий контекст — історія на ~50K токенів
function generateLargeContext(targetTokens = 50000) {
  const words = [ 
    'The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog',
    'Artificial', 'intelligence', 'machine', 'learning', 'deep', 'neural',
    'network', 'transformer', 'attention', 'mechanism', 'language', 'model',
    'token', 'embedding', 'vector', 'training', 'inference', 'prediction',
    'analysis', 'synthesis', 'generation', 'understanding', 'reasoning',
    'Python', 'JavaScript', 'TypeScript', 'Node', 'React', 'API', 'database',
    'server', 'client', 'frontend', 'backend', 'fullstack', 'architecture',
    'design', 'pattern', 'algorithm', 'data', 'structure', 'optimization'
  ];
  
  let messages = [];
  let tokens = 0;
  let turn = 0;
  
  while (tokens < targetTokens) {
    const userMsg = [];
    const wordCount = 30 + Math.floor(Math.random() * 50);
    for (let i = 0; i < wordCount; i++) {
      userMsg.push(words[Math.floor(Math.random() * words.length)]);
    }
    const userText = userMsg.join(' ') + '.';
    tokens += userText.split(' ').length * 1.3; // приблизно
    
    messages.push({ role: 'user', content: userText });
    
    const asstMsg = words.slice(0, 20 + Math.floor(Math.random() * 30)).join(' ') + '.';
    tokens += asstMsg.split(' ').length * 1.3;
    messages.push({ role: 'assistant', content: asstMsg });
    turn++;
  }
  
  return messages;
}

function makeRequest(url, data, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const mod = isHttps ? https : http;
    
    const body = JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
      },
      timeout: timeout
    };
    
    const req = mod.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(responseData), raw: responseData });
        } catch {
          resolve({ status: res.statusCode, data: responseData, raw: responseData });
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function startLiteLLMProxy() {
  return new Promise((resolve, reject) => {
    const configPath = path.join(__dirname, 'litellm-config.yaml');
    const configContent = `
model_list:
  - model_name: nvidia-nim
    litellm_params:
      model: openai/nvidia/meta/llama-3.1-8b-instruct
      api_key: ${process.env.NVIDIA_API_KEY}
      api_base: https://integrate.api.nvidia.com/v1
  - model_name: google-gemini
    litellm_params:
      model: gemini/gemini-2.0-flash-lite-001
      api_key: ${process.env.GOOGLE_API_KEY || ''}
general_settings:
  master_key: sk-litellm-test-key
`;
    fs.writeFileSync(configPath, configContent);
    
    const proc = spawn('python', ['-m', 'litellm', '--config', configPath, '--port', String(LITELLM_PORT), '--num_workers', '1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LITELLM_MASTER_KEY: 'sk-litellm-test-key' }
    });
    
    let started = false;
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      console.log('[LiteLLM]', text.slice(0, 200));
      if (text.includes('Server') || text.includes('running') || text.includes('localhost:' + LITELLM_PORT)) {
        if (!started) { started = true; setTimeout(() => resolve(proc), 2000); }
      }
    });
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.includes('Uvicorn running')) {
        if (!started) { started = true; setTimeout(() => resolve(proc), 2000); }
      }
    });
    
    setTimeout(() => {
      if (!started) resolve(proc); // force resolve after 10s
    }, 10000);
    
    proc.on('error', reject);
  });
}

async function runTest() {
  console.log('='.repeat(80));
  console.log('🔥 ПОРІВНЯННЯ: openai-nim-proxy vs LiteLLM');
  console.log('='.repeat(80));
  
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey || apiKey === 'nvapi-') {
    console.error('❌ Потрібен валідний NVIDIA_API_KEY в .env');
    process.exit(1);
  }
  
  // Генеруємо великий контекст + фінальний запит
  console.log('\n📦 Генерую великий контекст...');
  const contextMessages = generateLargeContext(50000); // ~50K токенів
  const finalPayload = {
    model: 'nvidia/meta/llama-3.1-8b-instruct',
    messages: [
      ...contextMessages.slice(-30), // останні 30 повідомлень для контексту
      { role: 'user', content: 'Please summarize the entire conversation in exactly 3 sentences. Start your response with "SUMMARY:"' }
    ],
    max_tokens: 200,
    temperature: 0.1
  };
  
  console.log(`📝 Повідомлень у запиті: ${finalPayload.messages.length}`);
  const approxTokens = JSON.stringify(finalPayload).length / 4;
  console.log(`📊 Приблизний розмір: ${Math.round(approxTokens)} токенів`);
  
  // Тест 1: openai-nim-proxy
  console.log('\n' + '-'.repeat(80));
  console.log('🧪 ТЕСТ 1: openai-nim-proxy');
  console.log('-'.repeat(80));
  
  try {
    const t0 = Date.now();
    const result = await makeRequest(`http://localhost:${PROXY_PORT}/v1/chat/completions`, finalPayload, 120000);
    const t1 = Date.now();
    const duration = t1 - t0;
    
    const content = result.data?.choices?.[0]?.message?.content || 'NO CONTENT';
    const finishReason = result.data?.choices?.[0]?.finish_reason || 'unknown';
    
    console.log(`⏱️  Час: ${duration}ms (${(duration/1000).toFixed(1)}s)`);
    console.log(`📋 Finish reason: ${finishReason}`);
    console.log(`📄 Content length: ${content.length} chars`);
    console.log(`📄 Content preview: ${content.slice(0, 200)}...`);
    console.log(`✅ Статус: ${result.status}`);
    
    // Перевірка чи контент не обрізаний
    if (finishReason === 'length') {
      console.log('⚠️  КОНТЕНТ ОБРІЗАНИЙ (finish_reason=length)');
    } else {
      console.log('✅ Контент не обрізаний');
    }
    
    // Перевірка чи відповідь повна
    if (content.includes('SUMMARY:')) {
      console.log('✅ Відповідь містить очікуваний маркер');
    } else {
      console.log('⚠️  Відповідь НЕ містить очікуваний маркер');
    }
  } catch (e) {
    console.log(`❌ openai-nim-proxy: ${e.message}`);
  }
  
  // Тест 2: LiteLLM
  console.log('\n' + '-'.repeat(80));
  console.log('🧪 ТЕСТ 2: LiteLLM');
  console.log('-'.repeat(80));
  
  let litellmProc = null;
  try {
    console.log('\n🚀 Запускаю LiteLLM...');
    litellmProc = await startLiteLLMProxy();
    console.log('✅ LiteLLM запущено');
    
    const t0 = Date.now();
    const result = await makeRequest(`http://localhost:${LITELLM_PORT}/chat/completions`, {
      ...finalPayload,
      model: 'nvidia-nim'
    }, 120000);
    const t1 = Date.now();
    const duration = t1 - t0;
    
    const content = result.data?.choices?.[0]?.message?.content || 'NO CONTENT';
    const finishReason = result.data?.choices?.[0]?.finish_reason || 'unknown';
    
    console.log(`⏱️  Час: ${duration}ms (${(duration/1000).toFixed(1)}s)`);
    console.log(`📋 Finish reason: ${finishReason}`);
    console.log(`📄 Content length: ${content.length} chars`);
    console.log(`📄 Content preview: ${content.slice(0, 200)}...`);
    console.log(`✅ Статус: ${result.status}`);
    
    if (finishReason === 'length') {
      console.log('⚠️  КОНТЕНТ ОБРІЗАНИЙ (finish_reason=length)');
    } else {
      console.log('✅ Контент не обрізаний');
    }
    
    if (content.includes('SUMMARY:')) {
      console.log('✅ Відповідь містить очікуваний маркер');
    } else {
      console.log('⚠️  Відповідь НЕ містить очікуваний маркер');
    }
  } catch (e) {
    console.log(`❌ LiteLLM: ${e.message}`);
  }
  
  // Cleanup
  if (litellmProc) {
    litellmProc.kill();
    try { fs.unlinkSync(path.join(__dirname, 'litellm-config.yaml')); } catch {}
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('🏁 ТЕСТ ЗАВЕРШЕНО');
  console.log('='.repeat(80));
}

runTest().catch(console.error);
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const PROXY_PORT = 3000;
const LITELLM_PORT = 4000;
const LITELLM_API_KEY = 'sk-68wfKO1lIMUABNxwW3ZchQ';

// Генеруємо великий контекст ~50K токенів
function generateLargeContext(targetTokens = 50000) {
  const topics = [
    'artificial intelligence', 'machine learning', 'neural networks', 'deep learning',
    'natural language processing', 'computer vision', 'reinforcement learning',
    'transformers', 'attention mechanisms', 'large language models',
    'data science', 'statistical analysis', 'probability theory', 'linear algebra',
    'calculus', 'optimization', 'gradient descent', 'backpropagation',
    'convolutional networks', 'recurrent networks', 'generative models',
    'GANs', 'VAEs', 'diffusion models', 'transfer learning',
    'fine-tuning', 'prompt engineering', 'RAG', 'vector databases',
    'embeddings', 'tokenization', 'semantic search', 'information retrieval',
    'knowledge graphs', 'ontology', 'reasoning', 'planning',
    'robotics', 'autonomous systems', 'control theory', 'sensors',
    'computer architecture', 'distributed systems', 'cloud computing',
    'edge computing', 'quantum computing', 'cybersecurity', 'cryptography'
  ];

  const templates = [
    'Explain the concept of {topic} in detail.',
    'What are the key principles of {topic}?',
    'How does {topic} relate to modern technology?',
    'Describe the history and evolution of {topic}.',
    'What are the main challenges in {topic} today?',
    'Compare different approaches to {topic}.',
    'What is the future of {topic}?',
    'How can {topic} be applied in real-world scenarios?',
    'What are the ethical considerations of {topic}?',
    'Provide examples of {topic} in practice.'
  ];

  let messages = [];
  let tokens = 0;

  while (tokens < targetTokens) {
    const topic = topics[Math.floor(Math.random() * topics.length)];
    const template = templates[Math.floor(Math.random() * templates.length)];
    const question = template.replace('{topic}', topic);
    tokens += question.split(' ').length * 1.3;

    messages.push({ role: 'user', content: question });

    // Відповідь асистента
    const responseWords = 40 + Math.floor(Math.random() * 80);
    let response = `${topic.charAt(0).toUpperCase() + topic.slice(1)} is a fascinating area. `;
    for (let i = 0; i < responseWords; i++) {
      response += topics[Math.floor(Math.random() * topics.length)] + ' ';
    }
    tokens += response.split(' ').length * 1.3;
    messages.push({ role: 'assistant', content: response + '.' });

    if (messages.length > 200) break;
  }

  return messages;
}

function makeRequest(hostname, port, pathname, data, headers = {}, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname, port, path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      },
      timeout
    };

    const req = http.request(options, (res) => {
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

async function testProxy(model, label, isLiteLLM = false) {
  console.log(`\n🧪 ТЕСТ: ${label}`);
  console.log(`   Модель: ${model}`);
  console.log('-'.repeat(60));

  // Генеруємо великий контекст
  console.log('📦 Генерую великий контекст (~50K токенів)...');
  const contextMessages = generateLargeContext(45000);

  const payload = {
    model: model,
    messages: [
      ...contextMessages.slice(-25),
      {
        role: 'user',
        content: `Please provide a comprehensive summary of everything discussed in this conversation.
Start your response with exactly "=== FULL SUMMARY ===".
Then provide a detailed point-by-point summary covering ALL topics mentioned.
End with exactly "=== END OF SUMMARY ===".
Make sure your response is complete and does not get cut off.`
      }
    ],
    max_tokens: 500,
    temperature: 0.3
  };

  const approxTokens = Math.round(JSON.stringify(payload).length / 4);
  console.log(`📊 Приблизний розмір запиту: ${approxTokens} токенів`);
  console.log(`📝 Повідомлень: ${payload.messages.length}`);

  const t0 = Date.now();

  try {
    if (isLiteLLM) {
      const result = await makeRequest('localhost', LITELLM_PORT, '/chat/completions', payload, {
        'Authorization': `Bearer ${LITELLM_API_KEY}`
      }, 180000);
      const t1 = Date.now();
      return analyzeResponse(result, t1 - t0);
    } else {
      const apiKey = process.env.GOOGLE_API_KEY;
      const result = await makeRequest('localhost', PROXY_PORT, '/v1/chat/completions', payload, {
        'Authorization': `Bearer ${apiKey}`
      }, 180000);
      const t1 = Date.now();
      return analyzeResponse(result, t1 - t0);
    }
  } catch (e) {
    console.log(`❌ Помилка: ${e.message}`);
    return { error: e.message, duration: Date.now() - t0 };
  }
}

function analyzeResponse(result, duration) {
  if (!result || result.status >= 400) {
    console.log(`❌ Статус: ${result?.status || 'unknown'}`);
    if (result?.raw) console.log(`   Відповідь: ${result.raw.slice(0, 300)}`);
    return { status: result?.status, duration, error: result?.raw?.slice(0, 200) };
  }

  const content = result.data?.choices?.[0]?.message?.content || '';
  const finishReason = result.data?.choices?.[0]?.finish_reason || 'unknown';
  const usage = result.data?.usage || {};

  console.log(`⏱️  Час: ${duration}ms (${(duration/1000).toFixed(1)}с)`);
  console.log(`📋 Finish reason: ${finishReason}`);
  console.log(`📄 Довжина контенту: ${content.length} символів`);
  console.log(`📊 Usage: ${JSON.stringify(usage)}`);

  // Перевірка повноти контенту
  let issues = [];

  if (finishReason === 'length') {
    issues.push('❌ КОНТЕНТ ОБРІЗАНИЙ (finish_reason = length)');
  } else if (finishReason === 'stop') {
    issues.push('✅ Контент завершився природньо (stop)');
  }

  if (content.includes('=== FULL SUMMARY ===')) {
    issues.push('✅ Містить початковий маркер');
  } else {
    issues.push('⚠️  НЕ містить початковий маркер "=== FULL SUMMARY ==="');
  }

  if (content.includes('=== END OF SUMMARY ===')) {
    issues.push('✅ Містить кінцевий маркер — відповідь повна');
  } else {
    issues.push('❌ НЕ містить кінцевий маркер "=== END OF SUMMARY ===" — ВІДПОВІДЬ ОБРІЗАНА');
  }

  // Перевірка чи немає обриву на півслові
  const lastChar = content.trim().slice(-1);
  if (lastChar !== '.' && lastChar !== '!' && lastChar !== '?' && lastChar !== '"' && lastChar !== ')' && lastChar !== '}') {
    if (!content.includes('=== END OF SUMMARY ===')) {
      issues.push('⚠️  Можливий обрив: останній символ не є знаком пунктуації');
    }
  }

  for (const issue of issues) {
    console.log(`   ${issue}`);
  }

  if (content.length > 0) {
    console.log(`📝 Перші 150 символів: ${content.slice(0, 150).replace(/\n/g, '\\n')}`);
    console.log(`📝 Останні 150 символів: ${content.slice(-150).replace(/\n/g, '\\n')}`);
  }

  return {
    duration,
    finishReason,
    contentLength: content.length,
    hasStartMarker: content.includes('=== FULL SUMMARY ==='),
    hasEndMarker: content.includes('=== END OF SUMMARY ==='),
    truncated: finishReason === 'length' || !content.includes('=== END OF SUMMARY ==='),
    usage
  };
}

async function runComparison() {
  console.log('='.repeat(70));
  console.log('🔥 ПОРІВНЯННЯ: openai-nim-proxy vs LiteLLM (Gemma-4-31b-it)');
  console.log('='.repeat(70));

  // Перевірка ключів
  const googleKey = process.env.GOOGLE_API_KEY;
  console.log(`\n🔑 GOOGLE_API_KEY: ${googleKey && googleKey !== 'nvapi-' && googleKey.length > 10 ? '✅' : '❌'}`);
  console.log(`🔑 LiteLLM_API_KEY: ${LITELLM_API_KEY ? '✅ (sk-68wfKO...)' : '❌'}`);

  // Тест 1: через наш проксі (Google провайдер) -> google/gemma-4-31b-it
  console.log('\n' + '='.repeat(70));
  console.log('🧪 ТЕСТ 1: openai-nim-proxy -> google/gemma-4-31b-it');
  console.log('='.repeat(70));
  const proxyResult = await testProxy('google/gemma-4-31b-it', 'openai-nim-proxy через Google');

  // Тест 2: через LiteLLM в Docker -> gem/gemma-4-31b-it
  console.log('\n' + '='.repeat(70));
  console.log('🧪 ТЕСТ 2: LiteLLM (Docker) -> gem/gemma-4-31b-it');
  console.log('='.repeat(70));
  const litellmResult = await testProxy('gem/gemma-4-31b-it', 'LiteLLM Docker', true);

  // Фінальне порівняння
  console.log('\n' + '='.repeat(70));
  console.log('📊 ФІНАЛЬНЕ ПОРІВНЯННЯ');
  console.log('='.repeat(70));

  console.log('\n📌 openai-nim-proxy (google/gemma-4-31b-it):');
  if (proxyResult) {
    console.log(`   Час: ${proxyResult.duration}ms (${(proxyResult.duration/1000).toFixed(1)}с)`);
    console.log(`   Finish reason: ${proxyResult.finishReason}`);
    console.log(`   Довжина: ${proxyResult.contentLength} символів`);
    console.log(`   Обрізано: ${proxyResult.truncated ? '❌ ТАК' : '✅ НІ'}`);
  } else {
    console.log('   ❌ Не вдалося протестувати');
  }

  console.log('\n📌 LiteLLM Docker (gem/gemma-4-31b-it):');
  if (litellmResult) {
    console.log(`   Час: ${litellmResult.duration}ms (${(litellmResult.duration/1000).toFixed(1)}с)`);
    console.log(`   Finish reason: ${litellmResult.finishReason}`);
    console.log(`   Довжина: ${litellmResult.contentLength} символів`);
    console.log(`   Обрізано: ${litellmResult.truncated ? '❌ ТАК' : '✅ НІ'}`);
  } else {
    console.log('   ❌ Не вдалося протестувати');
  }

  console.log('\n💡 ВИСНОВКИ:');
  console.log('   - Якщо обидва працюють однаково — проблема не в проксі, а в API провайдера');
  console.log('   - Якщо LiteLLM швидше/повніше — проблема в адаптері проксі');
  console.log('   - Якщо проксі обрізає контент — проблема в адаптері або timeout');
}

runComparison().catch(console.error);
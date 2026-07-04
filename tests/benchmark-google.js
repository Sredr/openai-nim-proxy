const axios = require('axios');
require('dotenv').config();

const GOOGLE_DIRECT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite-001:generateContent';
const GOOGLE_VIA_PROXY = 'http://localhost:3000/v1/chat/completions';

const payload = {
  messages: [
    { role: 'user', content: 'Say "Hello" and nothing else.' }
  ],
  max_tokens: 10,
  temperature: 0.1
};

const headers = { 'Content-Type': 'application/json' };

async function testDirect() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || apiKey === 'nvapi-') {
    console.log('⏭️ Прямий тест Google пропущено: немає GOOGLE_API_KEY');
    return null;
  }
  try {
    const t0 = Date.now();
    const res = await axios.post(`${GOOGLE_DIRECT}?key=${apiKey}`, {
      contents: [{ parts: [{ text: 'Say "Hello" and nothing else.' }] }]
    }, { headers, timeout: 30000 });
    const t1 = Date.now();
    console.log(`✅ Прямий Google API: ${t1-t0}ms`);
    return t1 - t0;
  } catch (e) {
    console.log(`❌ Прямий Google API: ${e.message}`);
    return null;
  }
}

async function testViaProxy() {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.NVIDIA_API_KEY;
  if (!apiKey || apiKey === 'nvapi-') {
    console.log('⏭️ Тест через проксі пропущено: немає ключа');
    return null;
  }
  try {
    const t0 = Date.now();
    const res = await axios.post(GOOGLE_VIA_PROXY, {
      ...payload,
      model: 'google/gemini-2.0-flash-lite-001'
    }, {
      headers: { ...headers, 'Authorization': `Bearer ${apiKey}` },
      timeout: 30000
    });
    const t1 = Date.now();
    console.log(`✅ Через проксі (google/gemini-2.0-flash-lite-001): ${t1-t0}ms`);
    return t1 - t0;
  } catch (e) {
    const data = e.response?.data;
    console.log(`❌ Через проксі: ${e.message} | ${JSON.stringify(data)}`);
    return null;
  }
}

(async () => {
  console.log('=== Бенчмарк: Google Gemini через проксі vs прямо ===\n');
  console.log('Ключ GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? '✅ встановлено' : '❌ відсутній');
  
  // Прогрів
  console.log('\nПрогрів...');
  await testViaProxy();
  
  console.log('\n=== Тест 1: Прямий запит до Google API ===');
  const directTime = await testDirect();
  
  console.log('\n=== Тест 2: Запит через проксі ===');
  // Робимо 3 запити для середнього
  let proxyTimes = [];
  for (let i = 0; i < 3; i++) {
    const t = await testViaProxy();
    if (t) proxyTimes.push(t);
  }
  
  console.log('\n=== РЕЗУЛЬТАТИ ===');
  if (directTime) console.log(`Прямий Google API: ${directTime}ms`);
  if (proxyTimes.length) {
    const avg = proxyTimes.reduce((a, b) => a + b, 0) / proxyTimes.length;
    console.log(`Через проксі (середнє): ${avg.toFixed(0)}ms`);
    if (directTime) {
      const diff = ((avg - directTime) / directTime * 100).toFixed(1);
      console.log(`Різниця: ${diff > 0 ? '+' : ''}${diff}%`);
      if (diff > 20) console.log('\n⚠️ Проксі додає значну затримку!');
      else console.log('\n✅ Затримка проксі мінімальна');
    }
  }
})();
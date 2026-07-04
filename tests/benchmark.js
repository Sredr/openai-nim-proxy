const http = require('http');

/**
 * Benchmark Tool for OpenAI NIM Proxy vs LiteLLM
 * Compares TTFB, Total Length, and Content Integrity
 */

const PROXY_URL = 'http://localhost:3000/v1/chat/completions';
const LITELM_URL = 'http://localhost:4000/v1/chat/completions'; // Change port if needed
const API_KEY = 'sk-placeholder'; // Not used for localhost but needed for compatibility
const MODEL = 'google/gemma-4-9b-it';

const PAYLOAD = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a helpful assistant. Always start your response with a <thought> block.' },
    { role: 'user', content: 'Write a short poem about a neon city in Ukrainian.' }
  ],
  stream: true,
  temperature: 0.7
};

async function runRequest(url, name) {
  console.log(`\n🚀 Starting request to ${name}...`);
  
  return new Promise((resolve) => {
    let firstByteTime = 0;
    let fullContent = '';
    let reasoningContent = '';
    let chunksCount = 0;
    const startTime = Date.now();

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      }
    }, (res) => {
      res.on('data', (chunk) => {
        if (firstByteTime === 0) firstByteTime = Date.now();
        chunksCount++;
        
        const text = chunk.toString();
        fullContent += text;

        // Basic SSE parsing to check for reasoning
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta;
              if (delta?.reasoning_content) {
                reasoningContent += delta.reasoning_content;
              }
            } catch (e) {
              // Ignore malformed chunks (common at chunk boundaries)
            }
          }
        }
      });

      res.on('end', () => {
        const totalTime = Date.now() - startTime;
        resolve({
          name,
          ttfb: firstByteTime - startTime,
          totalTime,
          length: fullContent.length,
          reasoningLength: reasoningContent.length,
          chunks: chunksCount,
          content: fullContent
        });
      });
    });

    req.on('error', (e) => {
      console.error(`❌ Error requesting ${name}: ${e.message}`);
      resolve({ name, error: e.message });
    });

    req.write(JSON.stringify(PAYLOAD));
    req.end();
  });
}

async function main() {
  console.log('=== AI Proxy Benchmark ===');
  console.log(`Model: ${MODEL}`);
  
  const results = await Promise.all([
    runRequest(PROXY_URL, 'Custom NIM Proxy'),
    runRequest(LITELM_URL, 'LiteLLM Docker')
  ]);

  console.log('\n\n' + '='.repeat(50));
  console.log('FINAL COMPARISON');
  console.log('='.repeat(50));
  
  console.log('Metric\t\t| Custom Proxy\t| LiteLLM');
  console.log('-'.repeat(50));
  
  const metrics = [
    { label: 'TTFB (ms)', key: 'ttfb' },
    { label: 'Total Time (ms)', key: 'totalTime' },
    { label: 'Total Bytes', key: 'length' },
    { label: 'Reasoning Bytes', key: 'reasoningLength' },
    { label: 'Chunks Count', key: 'chunks' },
  ];

  metrics.forEach(m => {
    const v1 = results[0][m.key] || 'N/A';
    const v2 = results[1][m.key] || 'N/A';
    console.log(`${m.label}\t| ${v1}\t\t| ${v2}`);
  });

  // Integrity Check
  const diff = Math.abs(results[0].length - results[1].length);
  console.log('-'.repeat(50));
  console.log(`Content Length Delta: ${diff} bytes`);
  if (diff < 100) {
    console.log('✅ Result: Content lengths are nearly identical.');
  } else {
    console.log('⚠️ Result: Significant difference in output length.');
  }
}

main().catch(console.error);
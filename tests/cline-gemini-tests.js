const assert = require('assert');
const adapters = require('../src/adapters');
const chatRoute = require('../src/routes/chat');

console.log('=== Running Cline & Gemma Thought Tests ===\n');

// 1. Тест думок Gemma (Non-streaming)
{
  const dataWithThought = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '<thought>I need to answer the user question politely.</thought>Hello! How can I help you today?'
        }
      }
    ]
  };

  // showReasoning = true
  const resReasoning = adapters.openai.formatRes(JSON.parse(JSON.stringify(dataWithThought)), { showReasoning: true });
  assert.strictEqual(resReasoning.choices[0].message.reasoning_content, 'I need to answer the user question politely.');
  assert.strictEqual(resReasoning.choices[0].message.content, 'Hello! How can I help you today?');
  console.log('✅ Gemma thought (non-streaming with showReasoning: true) PASSED');

  // showReasoning = false
  const resNoReasoning = adapters.openai.formatRes(JSON.parse(JSON.stringify(dataWithThought)), { showReasoning: false });
  assert.strictEqual(resNoReasoning.choices[0].message.reasoning_content, undefined);
  assert.strictEqual(resNoReasoning.choices[0].message.content, 'Hello! How can I help you today?');
  console.log('✅ Gemma thought (non-streaming with showReasoning: false) PASSED');
}

// 2. Тест думок Gemma (Streaming SSE)
{
  const testStreamChunk = (chunkStr, config) => {
    const emitted = [];
    const mockRes = {
      write: (data) => emitted.push(data)
    };
    adapters.openai.parseStream(Buffer.from(chunkStr), mockRes, config);
    adapters.openai.flushBuffer(mockRes, config);
    return emitted;
  };

  // Чанк з думкою Gemma
  const sseInput = 'data: {"id":"chatcmpl-test","model":"meta/llama-3.3-70b-instruct","choices":[{"index":0,"delta":{"content":"<thought>thinking deep</thought>Result answer"}}]}\n\n';

  // showReasoning: true
  const chunksReasoning = testStreamChunk(sseInput, { showReasoning: true });
  assert(chunksReasoning.length >= 2, 'Should emit reasoning chunk and content chunk');
  assert(chunksReasoning.some(c => c.includes('"reasoning_content":"thinking deep"')));
  assert(chunksReasoning.some(c => c.includes('"content":"Result answer"')));
  // Перевірка збереження id і model
  assert(chunksReasoning.every(c => c.includes('"id":"chatcmpl-test"')));
  assert(chunksReasoning.every(c => c.includes('"model":"meta/llama-3.3-70b-instruct"')));
  console.log('✅ Gemma thought (streaming with showReasoning: true and metadata preserved) PASSED');
}

// 3. Тест Cline/Roo: Стрімінг викликів інструментів (tool_calls)
{
  const testStreamChunk = (chunkStr) => {
    const emitted = [];
    const mockRes = {
      write: (data) => emitted.push(data)
    };
    adapters.openai.parseStream(Buffer.from(chunkStr), mockRes, { showReasoning: false });
    adapters.openai.flushBuffer(mockRes, { showReasoning: false });
    return emitted;
  };

  // Чанк 1: content порожній або відсутній, але є tool_calls
  const toolCallChunk = 'data: {"id":"chatcmpl-tool1","choices":[{"index":0,"delta":{"content":"","tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"test.txt\\"}"}}]},"finish_reason":null}]}\n\n';
  const emitted1 = testStreamChunk(toolCallChunk);
  assert.strictEqual(emitted1.length, 1);
  const parsed1 = JSON.parse(emitted1[0].replace(/^data: /, ''));
  assert.strictEqual(parsed1.choices[0].delta.tool_calls[0].function.name, 'read_file');
  assert.strictEqual(parsed1.id, 'chatcmpl-tool1');
  console.log('✅ Cline tool_calls streaming chunk with empty content PASSED');

  // Чанк 2: finish_reason: "tool_calls"
  const finishChunk = 'data: {"id":"chatcmpl-tool1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
  const emitted2 = testStreamChunk(finishChunk);
  assert.strictEqual(emitted2.length, 1);
  const parsed2 = JSON.parse(emitted2[0].replace(/^data: /, ''));
  assert.strictEqual(parsed2.choices[0].finish_reason, 'tool_calls');
  console.log('✅ Cline finish_reason: "tool_calls" streaming chunk PASSED');
}

// 4. Тест санітизації повідомлень Cline / Roo Code
{
  const sampleMessages = [
    {
      role: 'system',
      content: [
        { type: 'text', text: 'You are Roo Code agent.' }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'List files.' }
      ]
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'list_dir', arguments: '{}' }
        }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_abc',
      content: 'server.js\npackage.json'
    },
    {
      role: 'tool',
      tool_call_id: 'call_def',
      content: 'file2.txt'
    }
  ];

  const sanitized = chatRoute.sanitizeMessages(sampleMessages);
  assert.strictEqual(sanitized.length, 5, 'Should preserve all 5 messages including separate tool calls');
  assert.deepStrictEqual(sanitized[0].content, [{ type: 'text', text: 'You are Roo Code agent.' }], 'Structured system content should not be object Object');
  assert.strictEqual(sanitized[2].tool_calls[0].id, 'call_abc', 'tool_calls must be preserved');
  assert.strictEqual(sanitized[3].tool_call_id, 'call_abc', 'tool_call_id must be preserved on tool 1');
  assert.strictEqual(sanitized[4].tool_call_id, 'call_def', 'tool_call_id must be preserved on tool 2');
  console.log('✅ Cline structured messages and tool_calls preservation PASSED');

  // Тест злиття для звичайних чатів: 2 user повідомлення підряд
  const regularChatMessages = [
    { role: 'user', content: 'Part 1' },
    { role: 'user', content: 'Part 2' }
  ];
  const mergedRegular = chatRoute.sanitizeMessages(regularChatMessages);
  assert.strictEqual(mergedRegular.length, 1);
  assert.strictEqual(mergedRegular[0].content, 'Part 1\n\nPart 2');
  console.log('✅ Backward compatibility: regular chat consecutive user messages merging PASSED');
}

// 5. Тест адаптера formatReq: підтримка max_completion_tokens (Cline / Roo)
{
  const formatted = adapters.openai.formatReq({
    model: 'test',
    max_completion_tokens: 4096
  }, 'meta/llama-3.3-70b-instruct');
  assert.strictEqual(formatted.max_tokens, 4096, 'Should add max_tokens when max_completion_tokens is passed');
  console.log('✅ Cline max_completion_tokens formatReq adapter PASSED');
}

console.log('\n=== All Cline & Gemma compatibility tests completed successfully! ===\n');

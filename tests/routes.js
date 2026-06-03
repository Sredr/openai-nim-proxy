const { execSync } = require('child_process');

/**
 * Routing and Integrity Tests
 * Verifies that endpoints exist and basic routing logic works
 */

const TEST_CASES = [
  {
    name: 'Root 404 Check',
    command: 'curl.exe -s -I http://localhost:3000/',
    expectedStatus: '404'
  },
  {
    name: 'Chat Endpoint Check',
    command: 'curl.exe -s -X POST -H "Content-Type: application/json" -d "{\\"model\\":\\"default\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}" http://localhost:3000/v1/chat/completions',
    expectedStatus: '401' // Should be 401 since we have no API key
  },
  {
    name: 'Invalid Route Check',
    command: 'curl.exe -s -I http://localhost:3000/v1/invalid-route',
    expectedStatus: '404'
  }
];

async function runTests() {
  console.log('=== Routing & Integrity Tests ===\n');
  let passed = 0;

  for (const test of TEST_CASES) {
    process.stdout.write(`Running ${test.name}... `);
    try {
      const output = execSync(test.command).toString();
      if (output.includes(`HTTP/` + test.expectedStatus) || output.includes(` ${test.expectedStatus} `)) {
        console.log('✅ PASSED');
        passed++;
      } else {
        console.log(`❌ FAILED (Expected ${test.expectedStatus})`);
        console.log(`Actual output: ${output}`);
      }
    } catch (e) {
      // curl returns non-zero for 4xx/5xx sometimes depending on version/flags
      const output = e.stdout ? e.stdout.toString() : '';
      if (output.includes(test.expectedStatus)) {
        console.log('✅ PASSED');
        passed++;
      } else {
        console.log(`❌ ERROR: ${e.message}`);
      }
    }
  }

  console.log(`\nSummary: ${passed}/${TEST_CASES.length} passed`);
  if (passed !== TEST_CASES.length) process.exit(1);
}

runTests().catch(console.error);
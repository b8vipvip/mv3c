'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyToolResponse, probeToolBridge } = require('../toolBridge.cjs');

const provider = { baseURL: 'https://example.org/v1', apiKey: 'test-secret', models: ['gpt-6-sol'] };
const toolCall = {
  choices: [{ message: { tool_calls: [{
    type: 'function', function: { name: 'mv3c_tool_capability_probe', arguments: '{"echo":"mv3c-ready"}' },
  }] } }],
};

test('accepts only typed function calls with literal expected arguments', () => {
  assert.deepEqual(classifyToolResponse(toolCall), { supported: true, reason: 'structured_tool_call_confirmed' });
  assert.equal(classifyToolResponse({ choices: [{ message: { content: 'mv3c-ready' } }] }).supported, false);
  assert.equal(classifyToolResponse({ choices: [{ message: { tool_calls: [{
    type: 'function', function: { name: 'run_shell', arguments: '{}' },
  }] } }] }).supported, false);
  assert.equal(classifyToolResponse({ choices: [{ message: { tool_calls: [{
    type: 'function', function: { name: 'mv3c_tool_capability_probe', arguments: '{' },
  }] } }] }).reason, 'invalid_function_arguments');
});
test('the bridge only probes model output; never executes a tool or leaks credentials', async () => {
  let count = 0;
  let request;
  const result = await probeToolBridge(provider, {
    fetcher: async (url, init) => {
      count += 1;
      request = { url, init };
      return { ok: true, json: async () => toolCall };
    },
  });
  assert.equal(result.supported, true);
  assert.equal(count, 1);
  assert.equal(request.url, 'https://example.org/v1/chat/completions');
  const body = JSON.parse(request.init.body);
  assert.equal(body.stream, false);
  assert.equal(body.tools[0].function.name, 'mv3c_tool_capability_probe');
  assert.equal(body.tool_choice.function.name, 'mv3c_tool_capability_probe');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
});
test('HTTP failures return a false capability result without endpoint secret', async () => {
  const result = await probeToolBridge(provider, {
    fetcher: async () => ({ ok: false, status: 400 }),
  });
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'upstream_http_400');
});

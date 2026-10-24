'use strict';

/**
 * Chat2api tool-call compatibility probe.
 *
 * The application's existing MCP executor is the sole authority for
 * permissions, approvals and tool side effects. This module never executes
 * a model-provided instruction, opens a plugin connection or stores tokens.
 */
const PROBE_TOOL = 'mv3c_tool_capability_probe';

function classifyToolResponse(body) {
  const message = body?.choices?.[0]?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const match = calls.find((item) => item?.type === 'function' &&
    item.function?.name === PROBE_TOOL &&
    typeof item.function?.arguments === 'string');
  if (!match) return { supported: false, reason: 'no_structured_tool_call' };
  let args;
  try { args = JSON.parse(match.function.arguments); } catch {
    return { supported: false, reason: 'invalid_function_arguments' };
  }
  if (args?.echo !== 'mv3c-ready') {
    return { supported: false, reason: 'unexpected_function_arguments' };
  }
  return { supported: true, reason: 'structured_tool_call_confirmed' };
}

async function probeToolBridge(provider, options = {}) {
  const fetcher = options.fetcher || fetch;
  if (!provider || typeof provider.baseURL !== 'string' ||
      typeof provider.apiKey !== 'string' ||
      !Array.isArray(provider.models) || typeof provider.models[0] !== 'string') {
    throw new TypeError('Configured chat2api provider is required');
  }
  const endpoint = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const start = Date.now();
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: 'Bearer ' + provider.apiKey,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 45000),
    body: JSON.stringify({
      model: provider.models[0],
      stream: false,
      messages: [
        { role: 'system', content: 'Call the provided function with echo set to mv3c-ready. Do not answer with text.' },
        { role: 'user', content: 'Run the capability probe.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: PROBE_TOOL,
          description: 'Return the literal string mv3c-ready; no external effects.',
          parameters: {
            type: 'object',
            properties: { echo: { type: 'string', enum: ['mv3c-ready'] } },
            required: ['echo'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: PROBE_TOOL } },
    }),
  });
  if (!response.ok) {
    return {
      supported: false,
      reason: 'upstream_http_' + response.status,
      elapsedMs: Date.now() - start,
      model: provider.models[0],
    };
  }
  const classified = classifyToolResponse(await response.json());
  return { ...classified, elapsedMs: Date.now() - start, model: provider.models[0] };
}

module.exports = { PROBE_TOOL, classifyToolResponse, probeToolBridge };

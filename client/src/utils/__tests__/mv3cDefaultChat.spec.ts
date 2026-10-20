import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { resolveMv3cNewChatEndpoint } from '../mv3cDefaultChat';

const chat2api = { chat2api: { type: 'custom' }, agents: { type: 'agents' } } as unknown as TEndpointsConfig;

describe('mv3c normal new-chat model resolution', () => {
  it('chooses chat2api when no endpoint was selected', () => {
    expect(resolveMv3cNewChatEndpoint({ endpointsConfig: chat2api })).toBe('chat2api');
  });

  it('avoids sending messages to an agent endpoint with no agent ID', () => {
    expect(resolveMv3cNewChatEndpoint({
      selectedEndpoint: EModelEndpoint.agents,
      endpointsConfig: chat2api,
    })).toBe('chat2api');
  });

  it('keeps a deliberately selected agent', () => {
    expect(resolveMv3cNewChatEndpoint({
      selectedEndpoint: EModelEndpoint.agents,
      agentId: 'my-agent-id',
      endpointsConfig: chat2api,
    })).toBe(EModelEndpoint.agents);
  });

  it('preserves explicit models and installations without chat2api', () => {
    expect(resolveMv3cNewChatEndpoint({
      selectedEndpoint: 'another-endpoint' as EModelEndpoint,
      endpointsConfig: chat2api,
    })).toBe('another-endpoint');
    expect(resolveMv3cNewChatEndpoint({
      selectedEndpoint: EModelEndpoint.agents,
      endpointsConfig: { agents: {} } as TEndpointsConfig,
    })).toBe(EModelEndpoint.agents);
  });
});

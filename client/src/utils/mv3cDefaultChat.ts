import { EModelEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';

/** Standard mv3c chats need a model, not an unbound LibreChat agent.
 * Keep an intentionally chosen agent and all non-agent endpoints unchanged.
 */
export function resolveMv3cNewChatEndpoint({
  selectedEndpoint,
  endpointsConfig,
  agentId,
}: {
  selectedEndpoint?: EModelEndpoint | null;
  endpointsConfig: TEndpointsConfig;
  agentId?: string | null;
}): EModelEndpoint | undefined {
  if (
    endpointsConfig?.chat2api &&
    !agentId &&
    (!selectedEndpoint || isAgentsEndpoint(selectedEndpoint))
  ) {
    return 'chat2api' as EModelEndpoint;
  }
  return selectedEndpoint ?? undefined;
}

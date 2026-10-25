import type { PluginPreset } from './catalog';
import { AuthTypeEnum, AuthorizationTypeEnum } from './MCPServerDialog/hooks/useMCPServerForm';
import type { MCPServerInitial } from './MCPServerDialog/hooks/useMCPServerForm';

/**
 * One source of truth for the secure, credential-free form defaults used by
 * both the admin setup wizard and the user marketplace.
 */
export function initialMCPConfig(preset: Pick<PluginPreset,
  'name' | 'description' | 'url' | 'transport' | 'auth'>): MCPServerInitial {
  return {
    title: preset.name,
    description: preset.description,
    url: preset.url,
    type: preset.transport,
    auth: preset.auth === 'token' ? {
      auth_type: AuthTypeEnum.ServiceHttp,
      api_key_source: 'user',
      api_key_authorization_type: AuthorizationTypeEnum.Bearer,
    } : undefined,
  };
}

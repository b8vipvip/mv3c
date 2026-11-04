import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, getModelPickerSections } from '../utils';

const agentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  icon: null,
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('model selector utilities', () => {
  it('matches endpoint search aliases', () => {
    const results = filterItems([agentsEndpoint], 'marketplace', undefined, undefined);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('matches localized Marketplace labels', () => {
    const localize = ((key: string) => {
      if (key === 'com_agents_marketplace') {
        return 'Tienda de Agentes';
      }
      if (key === 'com_ui_marketplace') {
        return 'Tienda';
      }
      return key;
    }) as ReturnType<typeof useLocalize>;

    const results = filterItems([agentsEndpoint], 'tienda', undefined, undefined, localize);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('does not match agents when there are no selectable agent options', () => {
    const results = filterItems([disabledAgentsEndpoint], 'my agents', undefined, undefined);
    expect(results).toEqual([]);
  });
});


describe('mv3c flat model picker sections', () => {
  it('shows chat2api as direct model rows and excludes My Agents from provider rows', () => {
    const chat2api: Endpoint = {
      value: 'chat2api',
      label: 'chat2api',
      hasModels: true,
      icon: null,
      models: [{ name: 'gpt-5.6-sol' }, { name: 'gpt-6' }],
    };
    const other: Endpoint = { value: 'another-provider', label: 'Other', icon: null };

    const sections = getModelPickerSections([agentsEndpoint, chat2api, other]);

    expect(sections.directEndpoint).toEqual(chat2api);
    expect(sections.otherEndpoints).toEqual([other]);
  });
});

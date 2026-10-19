jest.mock('./mv3cSettings', () => ({
  buildRuntimeConfig: jest.fn(),
}));

const { buildRuntimeConfig } = require('./mv3cSettings');
const loadCustomConfig = require('./loadCustomConfig');

describe('mv3c MongoDB-backed configuration loader', () => {
  beforeEach(() => jest.resetAllMocks());

  it('loads the authoritative configuration from the database', async () => {
    const config = {
      version: '1.3.17',
      cache: true,
      interface: { customWelcome: 'mv3c' },
    };
    buildRuntimeConfig.mockResolvedValue(config);
    await expect(loadCustomConfig(true, { mode: 'startup' })).resolves.toEqual(config);
    expect(buildRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it('fails closed on database errors instead of falling back to stale YAML', async () => {
    buildRuntimeConfig.mockRejectedValue(new Error('MongoDB unavailable'));
    await expect(loadCustomConfig()).rejects.toThrow('MongoDB unavailable');
  });
});

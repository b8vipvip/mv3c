// mv3c uses one authoritative MongoDB-backed configuration source.
// The legacy librechat.yaml file is not loaded at runtime.
const { buildRuntimeConfig } = require('./mv3cSettings');
module.exports = async function loadCustomConfig() {
  return buildRuntimeConfig();
};

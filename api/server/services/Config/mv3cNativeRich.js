'use strict';
const mongoose = require('mongoose');
const { buildRuntimeConfig } = require('./mv3cSettings');
const { saveProviderBinding, readBoundSnapshot, nativeEndpoint } = require('../../../../mv3c/nativeRichBridge.cjs');
const COLLECTION = 'mv3c_native_rich_bindings';
let indexReady;
function collection() {
  if (!mongoose.connection.db) throw new Error('MongoDB unavailable');
  return mongoose.connection.db.collection(COLLECTION);
}
async function ensureIndex() {
  if (!indexReady) {
    indexReady = collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch(() => { indexReady = undefined; });
  }
  return indexReady;
}
async function recordModelNativeBinding(output, metadata) {
  // Only server-side model callback can call this. No user-provided request ID.
  if (!output?.response_metadata?.chat2api?.native_content) return false;
  await ensureIndex();
  return saveProviderBinding(collection(), output, metadata);
}
async function getNativeMessage({ user, conversationId, messageId }) {
  const config = await buildRuntimeConfig();
  return readBoundSnapshot({
    collection: collection(), user, conversationId, messageId, config,
  });
}
async function upstreamNativeEvents({ user, conversationId, messageId }) {
  const record = await collection().findOne({
    user, conversationId, messageId, expiresAt: { $gt: new Date() },
  });
  if (!record) return null;
  const config = await buildRuntimeConfig();
  const endpoint = nativeEndpoint(config, record.requestId, true);
  if (!endpoint) return null;
  return fetch(endpoint.url, {
    headers: { Authorization: 'Bearer ' + endpoint.token, Accept: 'text/event-stream' },
    redirect: 'error', signal: AbortSignal.timeout(900000),
  });
}
module.exports = { recordModelNativeBinding, getNativeMessage, upstreamNativeEvents };

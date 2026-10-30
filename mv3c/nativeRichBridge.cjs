'use strict';
const REQUEST_ID = /^req_[A-Za-z0-9_-]{6,100}$/;
const OWNER_ID = /^[A-Za-z0-9:_-]{4,150}$/;
const MAX_BYTES = 512 * 1024;
const TTL_SECONDS = 90 * 24 * 3600;
// Only provider response metadata is accepted. User text and user-controlled
// message fields can never establish an upstream request association.
function extractProviderBinding(output, meta) {
  const response = output?.response_metadata;
  const id = response?.chat2api?.request_id;
  const owner = meta?.user_id;
  const conversationId = meta?.thread_id;
  const messageId = meta?.run_id;
  if (typeof id !== 'string' || !REQUEST_ID.test(id) ||
      typeof owner !== 'string' || !OWNER_ID.test(owner) ||
      typeof conversationId !== 'string' || !OWNER_ID.test(conversationId) ||
      typeof messageId !== 'string' || !OWNER_ID.test(messageId)) return null;
  if (response?.chat2api?.native_content?.version !== 1) return null;
  return { user: owner, conversationId, messageId, requestId: id };
}
async function saveProviderBinding(collection, output, meta) {
  const binding = extractProviderBinding(output, meta);
  if (!binding) return false;
  await collection.updateOne(
    { user: binding.user, conversationId: binding.conversationId, messageId: binding.messageId },
    { $set: { requestId: binding.requestId, expiresAt: new Date(Date.now() + TTL_SECONDS * 1000) } },
    { upsert: true },
  );
  return true;
}
function validatedUpstreamConfig(config) {
  const provider = config?.endpoints?.custom?.find?.(item => item?.name === 'chat2api');
  const baseURL = provider?.baseURL;
  const apiKey = provider?.apiKey;
  if (typeof baseURL !== 'string' || typeof apiKey !== 'string' || apiKey.length < 1) return null;
  let url;
  try { url = new URL(baseURL); } catch { return null; }
  const local = ['localhost', '127.0.0.1', 'chat2api', 'host.docker.internal'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1')) return null;
  return { base: baseURL.replace(/\/+$/, ''), apiKey };
}
function nativeEndpoint(config, id, events = false) {
  const trusted = validatedUpstreamConfig(config);
  if (!trusted || !REQUEST_ID.test(id)) return null;
  return { url: trusted.base + '/native-content/' + encodeURIComponent(id) + (events ? '/events' : ''),
    token: trusted.apiKey };
}
// The configured HTTPS chat2api upstream is the sole trusted origin for this
// narrow upgrade. Reverse proxies can produce HTTP archive URLs when the
// request was server-to-server and supplied no browser Origin. Do not rewrite
// third-party domains, local aliases, arbitrary paths, query strings or ports.
function normalizeOwnedNativeAssetUrl(value, trusted) {
  if (typeof value !== 'string' || !trusted) return value;
  let upstream, candidate;
  try {
    upstream = new URL(trusted.base);
    candidate = new URL(value);
  } catch { return value; }
  if (upstream.protocol !== 'https:' || candidate.protocol !== 'http:' ||
      upstream.hostname.toLowerCase() !== candidate.hostname.toLowerCase() ||
      candidate.port || candidate.username || candidate.password ||
      candidate.search || candidate.hash) return value;
  const media = /^\/api\/media\/[a-zA-Z0-9_-]{6,100}\/[a-zA-Z0-9_-]{8,150}$/;
  const generated = /^\/api\/generated-files\/(?:pending\/pgen_[a-f0-9]{32}\/[a-zA-Z0-9_-]{16,150}|[a-zA-Z0-9_-]{6,100}\/[a-zA-Z0-9_-]{8,150})$/;
  if (!media.test(candidate.pathname) && !generated.test(candidate.pathname)) return value;
  return upstream.origin + candidate.pathname;
}
function normalizeBoundNativeSnapshot(payload, config) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.assets)) return payload;
  const trusted = validatedUpstreamConfig(config);
  if (!trusted) return payload;
  return {
    ...payload,
    assets: payload.assets.map(value => normalizeOwnedNativeAssetUrl(value, trusted)),
    ...(Array.isArray(payload.files) ? {
      files: payload.files.map(file => file && typeof file === 'object'
        ? { ...file, url: normalizeOwnedNativeAssetUrl(file.url, trusted) } : file),
    } : {}),
  };
}

async function readBoundSnapshot({ collection, user, conversationId, messageId, config, fetchImpl = fetch }) {
  const record = await collection.findOne({ user, conversationId, messageId, expiresAt: { $gt: new Date() } });
  if (!record) return null;
  const target = nativeEndpoint(config, record.requestId);
  if (!target) return null;
  const response = await fetchImpl(target.url, {
    headers: { Authorization: 'Bearer ' + target.token, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(6000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Native presentation upstream unavailable');
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Native payload too large');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Missing native response body');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Native payload too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const payload = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
  if (payload?.version !== 1 || !Number.isSafeInteger(payload.revision) ||
      !payload.root || !Array.isArray(payload.assets)) return null;
  return normalizeBoundNativeSnapshot(payload, config);
}
module.exports = {
  extractProviderBinding, saveProviderBinding, nativeEndpoint,
  readBoundSnapshot, validatedUpstreamConfig, normalizeBoundNativeSnapshot,
};

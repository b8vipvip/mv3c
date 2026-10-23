'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { sanitizeUserForAuthResponse } = require('@librechat/api');
const { findUser, createUser, getUserById } = require('~/models');
const { getPublicSettings } = require('./mv3cSettings');

const COOKIE = 'mv3c_guest';
const AGE_MS = 90 * 24 * 60 * 60 * 1000;
const PROVIDER = 'mv3c-guest';
const LIMIT_CODE = 'MV3C_GUEST_LIMIT';

function collection(name) {
  if (!mongoose.connection.db) throw new Error('MongoDB is not ready');
  return mongoose.connection.db.collection(name);
}
function cookieNonce(cookie) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  if (typeof cookie !== 'string') return null;
  const [nonce, tag, extra] = cookie.split('.');
  if (extra !== undefined || !/^[a-f0-9]{64}$/.test(nonce || '') ||
      !/^[a-f0-9]{64}$/.test(tag || '')) return null;
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(nonce).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(expected)) ? nonce : null;
}
function signCookie(nonce) {
  return nonce + '.' + crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(nonce).digest('hex');
}
function guestEmail(nonce) {
  return 'guest-' + crypto.createHash('sha256').update(nonce).digest('hex') + '@guest.mv3c.invalid';
}
function estimateTokens(text, count) {
  if (Number.isFinite(count) && count >= 0) return Math.ceil(count);
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}
function promptTokens(body) {
  const text = [body?.text, body?.prompt, body?.message?.text]
    .filter((value) => typeof value === 'string').join(' ');
  return estimateTokens(text);
}
/**
 * Snapshot persisted assistant output tokens into an append-only, idempotent ledger.
 * Message deletion does not reset an exhausted guest. Counts from message.tokenCount
 * are used when available, with a conservative fallback for older records.
 */
async function reconcileOutput(userId) {
  const charges = collection('mv3c_guest_output_charges');
  const cursor = collection('messages').find({ user: userId, isCreatedByUser: false },
    { projection: { messageId: 1, tokenCount: 1, text: 1 } });
  const batch = [];
  for await (const msg of cursor) {
    if (typeof msg.messageId !== 'string' || !msg.messageId) continue;
    batch.push({ updateOne: {
      filter: { _id: userId + ':' + msg.messageId },
      update: { $setOnInsert: {
        userId, tokens: estimateTokens(msg.text, msg.tokenCount),
      } },
      upsert: true,
    } });
    if (batch.length >= 250) {
      await charges.bulkWrite(batch, { ordered: false });
      batch.length = 0;
    }
  }
  if (batch.length) await charges.bulkWrite(batch, { ordered: false });
  const [sum] = await charges.aggregate([
    { $match: { userId } },
    { $group: { _id: null, total: { $sum: '$tokens' } } },
  ]).toArray();
  await collection('mv3c_guest_usage').updateOne({ _id: userId },
    { $max: { outputTokens: sum?.total || 0 } }, { upsert: true });
}
async function usageFor(userId) {
  await reconcileOutput(userId);
  const [row, config] = await Promise.all([
    collection('mv3c_guest_usage').findOne({ _id: userId }),
    getPublicSettings(),
  ]);
  const guest = config.guest;
  const usedTokens = (Number(row?.inputTokens) || 0) + (Number(row?.outputTokens) || 0);
  return {
    enabled: guest.enabled, tokenLimit: guest.tokenLimit, usedTokens,
    remainingTokens: Math.max(0, guest.tokenLimit - usedTokens),
    limitReached: !guest.enabled || usedTokens >= guest.tokenLimit,
  };
}
function deny(res, stats) {
  return res.status(403).json({
    code: LIMIT_CODE, message: '游客体验额度已用完，请注册或登录',
    usedTokens: stats.usedTokens, tokenLimit: stats.tokenLimit,
  });
}
/** Atomic reservation of request text, using the one guest usage document. */
async function admit(userId, body) {
  const stats = await usageFor(userId);
  if (stats.limitReached) return stats;
  const result = await collection('mv3c_guest_usage').updateOne({
    _id: userId,
    $expr: { $lt: [
      { $add: [{ $ifNull: ['$inputTokens', 0] }, { $ifNull: ['$outputTokens', 0] }] },
      stats.tokenLimit,
    ] },
  }, { $inc: { inputTokens: promptTokens(body) } });
  if (result.modifiedCount !== 1) return usageFor(userId);
  // The turn that reaches the threshold is allowed; subsequent ones are denied.
  return { ...stats, limitReached: false };
}
async function start(req, res) {
  try {
    const config = (await getPublicSettings()).guest;
    if (!config.enabled) return res.status(403).json({ message: '游客体验未启用' });
    const nonce = cookieNonce(req.cookies?.[COOKIE]) || crypto.randomBytes(32).toString('hex');
    const email = guestEmail(nonce);
    let user = await findUser({ email });
    if (!user) {
      user = await createUser({
        email, name: '游客', username: '', emailVerified: true,
        provider: PROVIDER, role: 'USER',
      }, undefined, true, true);
    }
    const userId = String(user._id);
    const stats = await usageFor(userId);
    res.cookie(COOKIE, signCookie(nonce), {
      httpOnly: true, sameSite: 'lax', secure: req.secure,
      maxAge: AGE_MS, path: '/api/auth',
    });
    const { setAuthTokens } = require('~/server/services/AuthService');
    const token = await setAuthTokens(userId, res, null, req);
    const fullUser = await getUserById(userId);
    return res.json({
      token, user: sanitizeUserForAuthResponse(fullUser), guest: true,
      usedTokens: stats.usedTokens, tokenLimit: stats.tokenLimit,
    });
  } catch {
    return res.status(500).json({ message: '无法初始化游客体验会话' });
  }
}
async function status(req, res) {
  if (req.user?.provider !== PROVIDER) {
    return res.status(403).json({ message: '仅游客账号可查询此额度' });
  }
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await usageFor(String(req.user.id || req.user._id)));
  } catch {
    return res.status(503).json({ message: '游客额度统计暂不可用' });
  }
}
module.exports = { start, status, admit, deny, PROVIDER, estimateTokens, promptTokens };

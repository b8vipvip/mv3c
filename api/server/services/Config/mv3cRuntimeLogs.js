'use strict';

/**
 * Bounded mv3c application runtime logs.
 * Existing LibreChat logger still sanitizes entries; this transport applies
 * those same redactors before writing one small, timestamped JSON line.
 * Only the known local filename family can ever be read by the admin export.
 */
const fs = require('node:fs');
const path = require('node:path');
const winston = require('winston');
const { baseLogFormat, redactMessage } = require('@librechat/data-schemas');

const FILE_NAME = 'mv3c-runtime.log';
const LOG_MAX_BYTES = 10 * 1024 * 1024;
// Winston's tailable transport may keep an extra active segment. Leave margin
// under 10 MiB even if it retains all four archives plus that active file.
const SEGMENT_BYTES = 1_900_000;
const MAX_FILES = 4;
const PRESETS = Object.freeze({
  '15m': 15, '1h': 60, '6h': 360,
  '24h': 1440, '3d': 4320, '7d': 10080,
});
const LOG_FILE_RE = /^mv3c-runtime(?:[1-9][0-9]*)?\.log(?:\.[1-9][0-9]*)?$/;

function logDirectory() {
  return process.env.MV3C_RUNTIME_LOG_DIR || path.resolve(process.cwd(), 'api/logs');
}
function validateRange(range) {
  if (!Object.prototype.hasOwnProperty.call(PRESETS, range)) {
    throw new TypeError('Invalid log time range');
  }
  return PRESETS[range];
}
function logFiles(dir = logDirectory()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => LOG_FILE_RE.test(name))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.lstatSync(fullPath);
      return stat.isFile() && !stat.isSymbolicLink()
        ? { path: fullPath, size: stat.size, modified: stat.mtimeMs }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.modified - b.modified);
}
function getStats(dir = logDirectory()) {
  const files = logFiles(dir);
  return {
    usedBytes: files.reduce((sum, file) => sum + file.size, 0),
    maxBytes: LOG_MAX_BYTES,
    fileCount: files.length,
    ranges: Object.keys(PRESETS),
    capture: 'Application logger and API request summaries; no request/response bodies',
  };
}
function getRecentLogText(range, dir = logDirectory(), now = Date.now()) {
  const minutes = validateRange(range);
  const cutoff = now - minutes * 60_000;
  const lines = [
    'mv3c server runtime log export',
    'Range: ' + range,
    'Generated: ' + new Date(now).toISOString(),
    'Source: bounded application runtime logs',
    'Note: rotated-out records are not recoverable.',
    '================================================',
  ];
  // Input is capped by the rotating transport; read only the freshest 10 MiB.
  let remaining = LOG_MAX_BYTES;
  const chunks = [];
  for (const file of logFiles(dir).reverse()) {
    if (remaining <= 0) break;
    const bytes = Math.min(file.size, remaining);
    if (!bytes) continue;
    const buffer = Buffer.alloc(bytes);
    const handle = fs.openSync(file.path, 'r');
    try {
      fs.readSync(handle, buffer, 0, bytes, file.size - bytes);
    } finally {
      fs.closeSync(handle);
    }
    chunks.push(buffer.toString('utf8'));
    remaining -= bytes;
  }
  for (const data of chunks.reverse()) {
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const timestamp = Date.parse(event.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now + 60_000) {
          continue;
        }
        const level = typeof event.level === 'string' ? event.level.slice(0, 12) : 'info';
        // Defense in depth when reading older entries with different formats.
        const message = redactMessage(String(event.message || '').slice(0, 8192));
        lines.push(new Date(timestamp).toISOString() + ' [' + level + '] ' +
          message.replace(/[\r\n]+/g, ' '));
      } catch {
        // Rotated files may begin/end with partial JSON lines; ignore them.
      }
    }
  }
  return lines.join('\n') + '\n';
}
function installRuntimeLogCapture(logger, dir = logDirectory()) {
  if (logger.__mv3cRuntimeCaptureInstalled) return;
  fs.mkdirSync(dir, { recursive: true });
  const compactRecord = winston.format((info) => ({
    timestamp: typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString(),
    level: String(info.level || 'info'),
    message: redactMessage(String(info.message || '').slice(0, 8192)).slice(0, 4096),
  }))();
  logger.add(new winston.transports.File({
    filename: path.join(dir, FILE_NAME),
    level: 'info',
    maxsize: SEGMENT_BYTES,
    maxFiles: MAX_FILES,
    tailable: true,
    format: winston.format.combine(baseLogFormat, compactRecord, winston.format.json()),
  }));
  // The upstream production logger defaults to WARN; info runtime diagnostics
  // must still reach its per-transport file and console transports.
  logger.level = 'info';
  logger.__mv3cRuntimeCaptureInstalled = true;
  logger.info('[mv3c-runtime] Bounded application log capture initialized');
}

module.exports = {
  FILE_NAME, LOG_MAX_BYTES, SEGMENT_BYTES, MAX_FILES, PRESETS,
  validateRange, getStats, getRecentLogText, installRuntimeLogCapture,
};

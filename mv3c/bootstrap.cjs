#!/usr/bin/env node
'use strict';
// Only immutable cryptographic bootstrap secrets live outside MongoDB.
// All user-facing settings and provider credentials are managed by mv3c Admin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const directory = process.env.MV3C_BOOTSTRAP_DIR || '/app/data';
const file = path.join(directory, 'mv3c-bootstrap.env');
const names = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDS_KEY', 'CREDS_IV'];

function makeBootstrapFile(target) {
  const values = Object.fromEntries(names.map((name) =>
    [name, crypto.randomBytes(name === 'CREDS_IV' ? 16 : 32).toString('hex')]));
  const data = names.map((name) => name + '=' + values[name]).join('\n') + '\n';
  let fd;
  try {
    fd = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function validateBootstrapFile(target) {
  const stat = fs.statSync(target);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('mv3c bootstrap secret file must not be accessible to group or others');
  }
  const content = fs.readFileSync(target, 'utf8');
  const lines = content.trim().split('\n');
  if (lines.length !== names.length) throw new Error('Invalid bootstrap secret file');
  for (let i = 0; i < names.length; i++) {
    if (!new RegExp('^' + names[i] + '=[a-f0-9]' +
      (names[i] === 'CREDS_IV' ? '{32}' : '{64}') + '$').test(lines[i])) {
      throw new Error('Invalid bootstrap secret: ' + names[i]);
    }
  }
  return true;
}
if (require.main === module) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  makeBootstrapFile(file);
  validateBootstrapFile(file);
  console.log('mv3c persistent bootstrap secrets are ready');
}
module.exports = { makeBootstrapFile, validateBootstrapFile };

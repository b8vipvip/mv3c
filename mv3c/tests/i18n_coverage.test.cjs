'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const english = require(path.join(root, 'client/src/locales/en/translation.json'));
const chinese = require(path.join(root, 'client/src/locales/zh-Hans/translation.json'));

const critical = [
  'com_ui_new_chat', 'com_ui_chat_history', 'com_nav_search_placeholder',
  'com_agents_my_agents', 'com_endpoint_agent_placeholder',
  'com_ui_mv3c_tools_more', 'com_ui_all_projects',
  'com_error_details_provider', 'com_error_upstream_model',
  'com_error_provider_failed', 'com_error_bad_request',
];

test('core mv3c chat and diagnostics have Simplified Chinese translations', () => {
  for (const key of critical) {
    assert.ok(key in english, 'Missing English source key: ' + key);
    assert.ok(typeof chinese[key] === 'string' && chinese[key].length > 0,
      'Missing Simplified Chinese source key: ' + key);
    assert.match(chinese[key], /[\u3400-\u9fff]/,
      'Key still uses English or pinyin: ' + key);
  }
});

test('print full Simplified Chinese coverage baseline for follow-up work', () => {
  const missing = Object.keys(english).filter((key) => !chinese[key]);
  const coverage = (100 * (1 - missing.length / Object.keys(english).length)).toFixed(1);
  console.log('Simplified Chinese coverage: ' + coverage + '%');
  console.log('Still missing ' + missing.length + ' UI strings of ' +
    Object.keys(english).length + '.');
  // Remaining translations are tracked instead of silently replaced with
  // guessed Chinese. This is not yet a 100%-translated application.
  assert.ok(missing.length < Object.keys(english).length);
});

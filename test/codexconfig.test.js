import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGlobal, removeGlobal, hasGlobal } from '../src/codexconfig.js';

const config = { host: '127.0.0.1', port: 8790, model: 'gpt-6.1-terra', defaultEffort: 'medium' };
const USER = [
  '# my settings',
  'model = "gpt-5"',
  'model_reasoning_effort = "high"',
  'approval_policy = "on-request"',
  '',
  '[mcp_servers.docs]',
  'command = "docs-mcp"',
  'model = "not a top-level key"',
  '',
].join('\n');

test('addGlobal puts our keys before every table and comments out the ones it replaces', () => {
  const out = addGlobal(USER, config);
  const lines = out.split('\n');
  const firstTable = lines.findIndex((l) => l.startsWith('['));
  const ours = ['model_provider = "layagpt"', 'model = "gpt-6.1-terra"', 'model_reasoning_effort = "medium"'];
  for (const line of ours) assert.ok(lines.indexOf(line) < firstTable, line);
  assert.ok(lines.includes('# laya-gpt saved: model = "gpt-5"'));
  assert.ok(lines.includes('# laya-gpt saved: model_reasoning_effort = "high"'));
  // Keys inside other tables and unrelated top-level keys are left alone.
  assert.ok(lines.includes('model = "not a top-level key"'));
  assert.ok(lines.includes('approval_policy = "on-request"'));
  assert.match(out, /\[model_providers\.layagpt\]\nname = "Laya GPT"\nbase_url = "http:\/\/127\.0\.0\.1:8790\/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n/);
  // One assignment per top-level key, so the file stays valid TOML.
  assert.equal(lines.filter((l) => /^model\s*=/.test(l)).length, 2);
  assert.equal(lines.slice(0, firstTable).filter((l) => /^model\s*=/.test(l)).length, 1);
  assert.ok(hasGlobal(out));
});

test('removeGlobal restores the file byte for byte, and installing twice changes nothing', () => {
  const once = addGlobal(USER, config);
  assert.equal(addGlobal(once, config), once);
  assert.equal(removeGlobal(once), USER);
  assert.equal(removeGlobal(USER), USER);
  assert.ok(!hasGlobal(USER));
});

test('addGlobal keeps CRLF line endings and works on an empty or table-less file', () => {
  const crlf = USER.replace(/\n/g, '\r\n');
  const out = addGlobal(crlf, config);
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(removeGlobal(out), crlf);
  assert.equal(removeGlobal(addGlobal('', config)), '');
  assert.match(addGlobal('model = "x"\n', { ...config, port: 9999 }), /^# laya-gpt saved: model = "x"$/m);
});

test('addGlobal refuses a file that defines its own layagpt provider', () => {
  assert.throws(() => addGlobal('[model_providers.layagpt]\nname = "mine"\n', config), /already defines \[model_providers\.layagpt\]/);
});

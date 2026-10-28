import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createProxy } from '../src/proxy.js';
import { VERSION, BUILD, APP, isOurProxy, compareBuild } from '../src/version.js';

test('build is a stable short hash and version comes from package.json', () => {
  assert.match(BUILD, /^[0-9a-f]{12}$/);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('isOurProxy accepts only health payloads that name laya-gpt', () => {
  assert.equal(APP, 'laya-gpt');
  assert.equal(isOurProxy({ app: 'laya-gpt', pid: 7 }), true);
  // Another app, an older payload without the field, and no payload at all are not ours.
  assert.equal(isOurProxy({ app: 'jev-effort', pid: 7 }), false);
  assert.equal(isOurProxy({ version: '0.4.0', build: 'aaaaaaaaaaaa', pid: 7 }), false);
  assert.equal(isOurProxy({ app: 'LAYA-GPT' }), false);
  assert.equal(isOurProxy(null), false);
  assert.equal(isOurProxy(undefined), false);
});

test('compareBuild tells current, stale and pre-version proxies apart', () => {
  const local = { version: '0.4.0', build: 'aaaaaaaaaaaa' };
  const health = { version: '0.4.0', build: 'aaaaaaaaaaaa', pid: 7, startedAt: '2026-10-27T08:30:00Z' };
  assert.equal(compareBuild(health, local).status, 'current');
  const stale = compareBuild({ ...health, build: 'bbbbbbbbbbbb' }, local);
  assert.equal(stale.status, 'stale');
  assert.match(stale.message, /pid 7.*rerun "laya-gpt serve"/);
  // Proxies from before this check report no build at all.
  assert.equal(compareBuild({ ok: true, mode: 'heuristic' }, local).status, 'stale');
  assert.match(compareBuild({ ok: true }, local).message, /older version without build info/);
});

test('/laya/health reports version, build, pid and start time', async () => {
  const { server } = createProxy(loadConfig({ LAYA_HOME: '.laya-test', LAYA_MODE: 'heuristic' }), { log: { write() {} }, print: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/laya/health`)).json();
    assert.equal(health.version, VERSION);
    assert.equal(health.build, BUILD);
    assert.equal(health.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(health.startedAt)));
    assert.equal(compareBuild(health).status, 'current');
  } finally {
    server.close();
  }
});

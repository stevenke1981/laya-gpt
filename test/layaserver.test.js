import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  layaEndpoint, deployDir, rememberDeployDir, venvPython, serveCommand, ensureLaya, startedPid, stopLaya,
} from '../src/layaserver.js';
import { loadConfig } from '../src/config.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'laya-server-'));
const configFor = (home, env = {}) => loadConfig({ LAYA_HOME: home, ...env });

test('layaEndpoint: only an http loopback URL is local', () => {
  assert.deepEqual(layaEndpoint('http://127.0.0.1:8100/api/alpha/decisions'),
    { host: '127.0.0.1', port: 8100, health: 'http://127.0.0.1:8100/health', local: true });
  assert.equal(layaEndpoint('http://localhost:9000/x').local, true);
  assert.equal(layaEndpoint('http://192.168.1.5:8100/x').local, false);
  assert.equal(layaEndpoint('https://laya.example.com/x').port, 443);
});

test('deployDir: env var, then the checkout setup recorded, then <home>/laya-deploy', () => {
  const home = tempDir();
  try {
    assert.equal(deployDir({}, home), path.join(home, 'laya-deploy'));
    rememberDeployDir(home, path.join(home, 'elsewhere'));
    assert.equal(deployDir({}, home), path.join(home, 'elsewhere'));
    assert.equal(deployDir({ LAYA_DEPLOY_DIR: path.join(home, 'env') }, home), path.join(home, 'env'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serveCommand runs the venv Python directly with the port, checkpoint and token laya-gpt uses', () => {
  const config = loadConfig({ LAYA_DECISION_URL: 'http://127.0.0.1:8123/api/alpha/decisions', LAYA_API_KEY: 'tok' });
  const cmd = serveCommand(config, 'D:/ld', {}, 'win32');
  assert.equal(cmd.file, path.join('D:/ld', '.venv', 'Scripts', 'python.exe'));
  assert.deepEqual(cmd.args, ['-m', 'laya_deploy.cli', 'serve']);
  assert.equal(cmd.cwd, 'D:/ld');
  assert.deepEqual(
    [cmd.env.LAYA_DEPLOY_HOST, cmd.env.LAYA_DEPLOY_PORT, cmd.env.LAYA_DEPLOY_PRELOAD, cmd.env.LAYA_DEPLOY_API_KEY],
    ['127.0.0.1', '8123', 'multilingual', 'tok'],
  );
  assert.equal(venvPython('/ld', {}, 'linux'), path.join('/ld', '.venv', 'bin', 'python'));
  assert.equal(venvPython('/ld', { LAYA_DEPLOY_PYTHON: '/usr/bin/python3' }, 'linux'), '/usr/bin/python3');
  assert.equal(serveCommand(loadConfig({ LAYA_DECISION_MODEL: 'auto' }), '/ld', {}, 'linux').env.LAYA_DEPLOY_PRELOAD, 'english,multilingual');
});

test('ensureLaya: off, remote, missing and started, without waiting for the model', async () => {
  const home = tempDir();
  // Nothing listens on this port, so laya is "down".
  const down = { LAYA_DECISION_URL: 'http://127.0.0.1:9/api/alpha/decisions' };
  try {
    assert.equal((await ensureLaya(configFor(home, { ...down, LAYA_AUTOSTART: 'off' }))).state, 'off');
    assert.equal((await ensureLaya(configFor(home, { LAYA_MODE: 'heuristic' }))).state, 'off');
    assert.equal((await ensureLaya(configFor(home, { LAYA_DECISION_URL: 'http://10.0.0.1:8100/x' }))).state, 'remote');

    const env = { LAYA_DEPLOY_DIR: path.join(home, 'ld') };
    const missing = await ensureLaya(configFor(home, down), { env, spawnFn: () => assert.fail('must not spawn') });
    assert.equal(missing.state, 'missing');
    assert.match(missing.detail, /laya-gpt setup/);

    // A real long-lived child stands in for the server, so the PID checks see a live process.
    const python = process.execPath;
    const calls = [];
    const spawnFn = (file, args, opts) => {
      calls.push({ file, args, opts });
      return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    };
    const config = configFor(home, down);
    const started = await ensureLaya(config, { env: { ...env, LAYA_DEPLOY_PYTHON: python }, spawnFn });
    assert.equal(started.state, 'started');
    assert.equal(calls[0].file, python);
    assert.equal(calls[0].opts.env.LAYA_DEPLOY_PORT, '9');
    assert.equal(calls[0].opts.detached, true);
    const pid = startedPid(config);
    assert.ok(Number.isInteger(pid));

    // Started but not answering yet: it is loading, so a second call does not start another.
    assert.equal((await ensureLaya(config, { env: { ...env, LAYA_DEPLOY_PYTHON: python }, spawnFn })).state, 'loading');
    assert.equal(calls.length, 1);

    assert.equal(stopLaya(config), pid);
    assert.equal(startedPid(config), null);
    assert.equal(stopLaya(config), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensureLaya: a laya that answers is reused, and a missing checkpoint is reported', async () => {
  const home = tempDir();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', loaded: ['english'] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/alpha/decisions`;
  try {
    const spawnFn = () => assert.fail('must not spawn');
    const other = await ensureLaya(configFor(home, { LAYA_DECISION_URL: url }), { spawnFn });
    assert.equal(other.state, 'running');
    assert.match(other.detail, /"multilingual" not loaded yet/);
    const ready = await ensureLaya(configFor(home, { LAYA_DECISION_URL: url, LAYA_DECISION_MODEL: 'english' }), { spawnFn });
    assert.deepEqual(ready, { state: 'running', detail: 'loaded english' });
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

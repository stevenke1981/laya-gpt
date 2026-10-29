import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/laya.js', import.meta.url));
const RUN_TIMEOUT_MS = 15000;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'laya-gpt-test-'));
}

/** Answers /laya/health with the given payload on a free port, as another app would. */
async function fakeHealthServer(payload) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const health = req.url === '/laya/health';
    res.writeHead(health ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health ? payload : {}));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    close: () => new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    }),
  };
}

/** A real process the CLI must never signal. */
function bystander() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

test('laya-gpt stop stops a running proxy and is a no-op when none runs', async () => {
  const port = await freePort();
  const env = { ...process.env, LAYA_PORT: String(port), LAYA_HOME: '.laya-test', LAYA_MODE: 'heuristic', LAYA_QUIET: '1' };
  const child = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 50 && (await run(['status'], env)).code !== 0; i++) await new Promise((r) => setTimeout(r, 100));

    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 0, stopped.out);
    assert.match(stopped.out, new RegExp(`stopped laya-gpt proxy \\(pid ${child.pid},`));
    await exited;

    const again = await run(['stop'], env);
    assert.equal(again.code, 0);
    assert.match(again.out, /no laya-gpt proxy/);
  } finally {
    child.kill();
  }
});

test('stop and status never signal or reuse a server that does not name laya-gpt', async () => {
  const victim = bystander();
  const home = tempDir();
  const fake = await fakeHealthServer({ app: 'some-other-app', version: '9.9.9', build: 'x', pid: victim.pid });
  const anon = await fakeHealthServer({ version: '9.9.9', build: 'x', pid: victim.pid });
  const env = { ...process.env, LAYA_PORT: String(fake.port), LAYA_HOME: home, LAYA_QUIET: '1' };
  try {
    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 1, stopped.out);
    assert.match(stopped.out, /port \d+ is answered by app "some-other-app", not a laya-gpt proxy/);
    assert.match(stopped.out, /not stopping it/);

    const status = await run(['status'], env);
    assert.equal(status.code, 1);
    assert.match(status.out, /not a laya-gpt proxy/);

    // A server whose health has no app field at all is foreign too.
    const anonStop = await run(['stop'], { ...env, LAYA_PORT: String(anon.port) });
    assert.equal(anonStop.code, 1);
    assert.match(anonStop.out, /no app id/);

    // Codex must not be pointed at a foreign server: ensureProxy refuses before any codex lookup.
    // PATH and APPDATA are emptied so that, if the guard regressed, codex still could not start.
    const codex = await run(['codex'], { ...env, PATH: '', Path: '', APPDATA: home });
    assert.equal(codex.code, 1);
    assert.match(codex.out, /not a laya-gpt proxy/);

    assert.equal(victim.exitCode, null, 'bystander exited, so the CLI signalled it');
    assert.equal(victim.signalCode, null, 'bystander was signalled');
  } finally {
    victim.kill();
    await fake.close();
    await anon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serve names the other app when its port is taken and does not reuse it', async () => {
  const fake = await fakeHealthServer({ app: 'other-app' });
  const home = tempDir();
  try {
    const served = await run(['serve'], { ...process.env, LAYA_PORT: String(fake.port), LAYA_HOME: home, LAYA_QUIET: '1' });
    assert.equal(served.code, 1, served.out);
    assert.match(served.out, /EADDRINUSE/);
    assert.match(served.out, /answered by app "other-app", not a laya-gpt proxy/);
  } finally {
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serve follows decisions when an existing laya-gpt proxy owns the port', async () => {
  const fake = await fakeHealthServer({ app: 'laya-gpt', version: '0.3.0', build: 'old', pid: 123 });
  const home = tempDir();
  const child = spawn(process.execPath, [CLI, 'serve'], {
    env: { ...process.env, LAYA_PORT: String(fake.port), LAYA_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    for (let i = 0; i < 50 && !output.includes('following'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(output, /Following decisions/);
    const record = JSON.stringify({ step: 7, effort: 'high', hold: 1, ms: 3, reasons: ['test decision'] }) + '\n';
    fs.appendFileSync(path.join(home, 'decisions.jsonl'), record.slice(0, 15));
    await new Promise((r) => setTimeout(r, 500));
    fs.appendFileSync(path.join(home, 'decisions.jsonl'), record.slice(15));
    for (let i = 0; i < 50 && !output.includes('test decision'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(output, /HIGH/);
    assert.match(output, /test decision/);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install writes the layagpt Codex profile for the configured model and default effort, refusing foreign files', async () => {
  const codexHome = tempDir();
  const env = { ...process.env, CODEX_HOME: codexHome, LAYA_PORT: '9999', LAYA_GPT_MODEL: 'gpt-6.1-terra', LAYA_HOME: codexHome };
  const file = path.join(codexHome, 'layagpt.config.toml');
  try {
    const first = await run(['install'], env);
    assert.equal(first.code, 0, first.out);
    const toml = fs.readFileSync(file, 'utf8');
    assert.ok(toml.startsWith('# Generated by `laya-gpt install`'));
    assert.match(toml, /^model_provider = "layagpt"$/m);
    assert.match(toml, /^model = "gpt-6\.1-terra"$/m);
    assert.match(toml, /^model_reasoning_effort = "medium"$/m);
    assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:9999\/v1"$/m);
    assert.ok(toml.indexOf('model_reasoning_effort = ') < toml.indexOf('[model_providers.layagpt]'), 'settings must sit above the table');
    assert.ok(!fs.existsSync(path.join(codexHome, 'laya.config.toml')));

    fs.writeFileSync(file, 'hand written\n');
    const second = await run(['install'], env);
    assert.equal(second.code, 1);
    assert.match(second.out, /was not written by laya-gpt/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hand written\n');
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install --global makes laya-gpt the default in config.toml with a backup; uninstall restores it', async () => {
  const codexHome = tempDir();
  const env = { ...process.env, CODEX_HOME: codexHome, LAYA_PORT: '9999', LAYA_HOME: codexHome };
  const main = path.join(codexHome, 'config.toml');
  const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
  try {
    fs.writeFileSync(main, original);
    const first = await run(['install', '--global'], env);
    assert.equal(first.code, 0, first.out);
    assert.match(fs.readFileSync(main, 'utf8'), /^model_provider = "layagpt"$/m);
    assert.equal(fs.readFileSync(`${main}.laya-gpt.bak`, 'utf8'), original);
    assert.ok(fs.existsSync(path.join(codexHome, 'layagpt.config.toml')));

    const second = await run(['install', '--global'], env);
    assert.equal(second.code, 0, second.out);
    assert.equal(fs.readFileSync(`${main}.laya-gpt.bak`, 'utf8'), original);

    const undo = await run(['uninstall'], env);
    assert.equal(undo.code, 0, undo.out);
    assert.equal(fs.readFileSync(main, 'utf8'), original);
    assert.ok(!fs.existsSync(path.join(codexHome, 'layagpt.config.toml')));
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('stats groups decisions by effort in ladder order and counts resumed early stops', async () => {
  const home = tempDir();
  const rows = [
    { model: 'gpt-6.1-terra', effort: 'xhigh', session: 'a', source: 'laya', cost: 0.001,
      usage: { input_tokens: 400, input_tokens_details: { cached_tokens: 300 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 50 } }, continues: [{ effort: 'xhigh' }] },
    { model: 'gpt-6.1-terra', effort: 'low', session: 'b', usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } },
    { model: 'gpt-6.1-terra', effort: 'low', session: 'b', usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } } },
    { model: 'gpt-6.1-terra', effort: 'medium', session: 'c', continues: [{ effort: 'high' }, { effort: 'xhigh' }] },
    { model: 'gpt-6.1-terra', effort: null, session: 'd' },
  ];
  fs.writeFileSync(path.join(home, 'decisions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    const res = await run(['stats'], { ...process.env, LAYA_HOME: home });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /^5 generations, 4 sessions, 1 routed by laya, 3 early stops resumed/);
    assert.match(res.out, /low\s+2 gens\s+0 avg reasoning tok\s+30 output tok/);
    assert.match(res.out, /xhigh\s+1 gens\s+50 avg reasoning tok\s+100 output tok/);
    assert.match(res.out, /\n {2}-\s+1 gens/);
    assert.match(res.out, /prompt cache: 300 of 400 input tok cached \(75\.0%\)/);

    const order = ['  low', '  medium', '  xhigh', '  -'].map((s) => res.out.indexOf(s));
    assert.ok(order.every((i) => i > 0), res.out);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('help names the laya-gpt commands, the variables and the port', async () => {
  const home = tempDir();
  try {
    const res = await run([], { ...process.env, LAYA_HOME: home });
    assert.equal(res.code, 0);
    assert.match(res.out, /laya-gpt serve/);
    assert.match(res.out, /codex -p layagpt/);
    for (const name of ['LAYA_GPT_MODEL (gpt-6.1-terra)', 'LAYA_DEFAULT_EFFORT (medium)', 'LAYA_CONTINUE (on|off)',
      'LAYA_MAX_CONTINUES (5)', 'LAYA_NUDGE (on|off)', 'LAYA_PORT (8790)']) {
      assert.ok(res.out.includes(name), `help is missing ${name}`);
    }
    assert.match(res.out, /http:\/\/127\.0\.0\.1:8790\/v1, model laya-auto/);
    assert.doesNotMatch(res.out, /jev-effort|jev-sol-terra|JEV_SOL_MODEL/);

    const version = await run(['--version'], { ...process.env, LAYA_HOME: home });
    assert.match(version.out, /^laya-gpt v\d+\.\d+\.\d+ \(build [0-9a-f]{12}\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('skills installs laya-gpt and laya-deploy skills into CODEX_HOME and uninstall removes them, leaving ~/.claude alone', async () => {
  const codexHome = tempDir();
  const fakeHome = tempDir();
  const deploy = tempDir();
  const home = tempDir();
  const laDir = path.join(deploy, 'skills', 'laya-decisions');
  fs.mkdirSync(laDir, { recursive: true });
  fs.writeFileSync(path.join(laDir, 'SKILL.md'), '---\nname: laya-decisions\n---\n');
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: fakeHome, LAYA_DEPLOY_DIR: deploy, LAYA_HOME: home, LAYA_QUIET: '1' };
  try {
    const installed = await run(['skills'], env);
    assert.equal(installed.code, 0, installed.out);
    const skillsDir = path.join(codexHome, 'skills');
    assert.ok(installed.out.includes(`installed laya-gpt, laya-decisions into ${skillsDir}`), installed.out);
    assert.ok(fs.existsSync(path.join(skillsDir, 'laya-gpt', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillsDir, 'laya-decisions', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillsDir, 'laya-gpt', '.laya-gpt-skill')));
    assert.ok(!fs.existsSync(path.join(fakeHome, '.claude')), 'skills without --claude touched ~/.claude');

    const removed = await run(['uninstall'], env);
    assert.equal(removed.code, 0, removed.out);
    assert.match(removed.out, /removed skill laya-gpt from /);
    assert.match(removed.out, /removed skill laya-decisions from /);
    assert.ok(!fs.existsSync(path.join(skillsDir, 'laya-gpt')));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'laya-decisions')));
  } finally {
    for (const dir of [codexHome, fakeHome, deploy, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

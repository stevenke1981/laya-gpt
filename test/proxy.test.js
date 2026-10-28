import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { loadConfig } from '../src/config.js';
import { createProxy, upstreamBase, upstreamUrl } from '../src/proxy.js';
import { parseVerdict, readOutputText } from '../src/judge.js';

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

const SSE = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"output_tokens":9,"output_tokens_details":{"reasoning_tokens":7}}}}\n\n',
];

async function harness(env = {}, deps = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"models":[]}');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of SSE) res.write(e);
      res.end();
    });
  });
  const upPort = await listen(upstream);
  const logged = [];
  const config = loadConfig({ LAYA_UPSTREAM: `http://127.0.0.1:${upPort}/base`, LAYA_HOME: '.laya-test', ...env });
  const { server, stats } = createProxy(config, { log: { write: (r) => logged.push(r) }, print: () => {}, ...deps });
  const port = await listen(server);
  const close = () => { server.close(); upstream.close(); };
  return { port, seen, logged, stats, close };
}

const request = (input, extra = {}) => ({
  model: 'gpt-x', instructions: 'SYSTEM', input, reasoning: { effort: 'high', summary: 'auto' },
  stream: true, prompt_cache_key: 'sess-1', ...extra,
});
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

test('rewrites only reasoning.effort and streams the response through', async () => {
  const h = await harness();
  try {
    const body = request([user('hi!')]);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), SSE.join(''));
    const sent = JSON.parse(h.seen[0].body);
    assert.equal(h.seen[0].url, '/base/responses');
    assert.equal(h.seen[0].headers.authorization, 'Bearer sk-test');
    assert.deepEqual(sent.reasoning, { effort: 'low', summary: 'auto' });
    assert.deepEqual({ ...sent, reasoning: body.reasoning }, body, 'everything else must be byte-identical for caching');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.logged[0].usage.output_tokens_details.reasoning_tokens, 7);
  } finally {
    h.close();
  }
});

test('decodes zstd request bodies', async () => {
  const h = await harness();
  try {
    const raw = zlib.zstdCompressSync(Buffer.from(JSON.stringify(request([user('hi')]))));
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' }, body: raw,
    });
    await res.text();
    assert.equal(JSON.parse(h.seen[0].body).reasoning.effort, 'low');
    assert.equal(h.seen[0].headers['content-encoding'], undefined);
  } finally {
    h.close();
  }
});

test('leaves non-reasoning requests and other paths untouched', async () => {
  const h = await harness();
  try {
    const body = { model: 'gpt-x', input: [user('hi')], stream: true };
    await (await fetch(`http://127.0.0.1:${h.port}/v1/responses`, { method: 'POST', body: JSON.stringify(body) })).text();
    assert.deepEqual(JSON.parse(h.seen[0].body), body);
    const models = await fetch(`http://127.0.0.1:${h.port}/v1/models?client_version=1`);
    assert.equal(await models.text(), '{"models":[]}');
    assert.equal(h.seen[1].url, '/base/models?client_version=1');
  } finally {
    h.close();
  }
});

test('llm mode uses the judge and falls back to heuristic on error', async () => {
  let calls = 0;
  const judgeFn = async () => {
    calls++;
    if (calls === 2) throw new Error('timeout');
    return { target: 2, hold: 1, reasons: ['judge: stuck'] };
  };
  const h = await harness({ LAYA_MODE: 'llm' }, { judgeFn });
  try {
    const step = (n) => [user('fix it'), ...Array.from({ length: n }, (_, i) => [
      { type: 'function_call', name: 'shell', call_id: `k${i}`, arguments: '{"command":["ls"]}' },
      { type: 'function_call_output', call_id: `k${i}`, output: 'Exit code: 0' },
    ]).flat()];
    for (const n of [1, 2]) {
      await (await fetch(`http://127.0.0.1:${h.port}/v1/responses`, { method: 'POST', body: JSON.stringify(request(step(n))) })).text();
    }
    assert.equal(h.logged[0].source, 'judge');
    assert.equal(JSON.parse(h.seen[0].body).reasoning.effort, 'high');
    assert.match(h.logged[1].source, /judge failed: timeout/);
  } finally {
    h.close();
  }
});

test('rejects request paths that would leave the upstream origin', async () => {
  assert.throws(() => upstreamUrl('https://api.openai.com/v1', '@evil.example/x'), /invalid request path/);
  assert.throws(() => upstreamUrl('https://api.openai.com/v1', '//evil.example/x'), /invalid request path/);
  const h = await harness();
  try {
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, method: 'GET', path: '@evil.example/x' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.equal(status, 400);
    assert.equal(h.seen.length, 0);
    const nullBody = await fetch(`http://127.0.0.1:${h.port}/v1/responses`, { method: 'POST', body: 'null' });
    assert.equal(nullBody.status, 400);
  } finally {
    h.close();
  }
});

test('upstream selection follows the auth type', () => {
  const cfg = loadConfig({});
  assert.equal(upstreamBase(cfg, { authorization: 'Bearer sk-abc' }), 'https://api.openai.com/v1');
  assert.equal(upstreamBase(cfg, { authorization: 'Bearer eyJhbGciOi' }), 'https://chatgpt.com/backend-api/codex');
  assert.equal(upstreamBase(cfg, { 'chatgpt-account-id': 'a' }), 'https://chatgpt.com/backend-api/codex');
  assert.equal(upstreamUrl('https://u/codex', '/v1/responses?a=1'), 'https://u/codex/responses?a=1');
});

test('judge verdict parsing and SSE text collection', async () => {
  assert.deepEqual(parseVerdict('ok {"effort":"MEDIUM","hold":9,"reason":"x"}', ['low', 'medium']).hold, 3);
  assert.equal(parseVerdict('{"effort":"ultra"}', ['low']), null);
  const res = new Response('data: {"type":"response.output_text.delta","delta":"{\\"a\\""}\n\ndata: {"type":"response.output_text.delta","delta":":1}"}\n\n');
  assert.equal(await readOutputText(res), '{"a":1}');
});

test('config rejects invalid ladders and modes', () => {
  assert.throws(() => loadConfig({ LAYA_LEVELS: 'low,turbo' }), /LAYA_LEVELS/);
  assert.throws(() => loadConfig({ LAYA_MODE: 'smart' }), /LAYA_MODE/);
});

test('laya-auto is rewritten to the configured model id; other models keep their name', async () => {
  const h = await harness({ LAYA_MODE: 'heuristic' });
  try {
    const post = (model) => fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request([user('hi')], { model })),
    }).then((r) => r.text());
    await post('laya-auto');
    await post('gpt-x');
    assert.equal(JSON.parse(h.seen[0].body).model, 'gpt-6.1-terra');
    assert.equal(JSON.parse(h.seen[1].body).model, 'gpt-x');
    assert.deepEqual(h.logged.map((r) => [r.requested, r.model]), [['laya-auto', 'gpt-6.1-terra'], ['gpt-x', 'gpt-x']]);
  } finally {
    h.close();
  }
});

test('LAYA_MODE=off still maps laya-auto to the model and leaves the effort alone', async () => {
  const h = await harness({ LAYA_MODE: 'off' });
  try {
    await fetch(`http://127.0.0.1:${h.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request([user('hi')], { model: 'laya-auto' })),
    }).then((r) => r.text());
    const sent = JSON.parse(h.seen[0].body);
    assert.equal(sent.model, 'gpt-6.1-terra');
    assert.equal(sent.reasoning.effort, 'high');
  } finally {
    h.close();
  }
});

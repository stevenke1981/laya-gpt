import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createProxy, upstreamBase } from '../src/proxy.js';
import { parseChatTurn, applyChatEffort, chatSessionKey } from '../src/chat.js';
import { assess } from '../src/policy.js';

const LADDER = ['low', 'medium', 'high'];
let id = 0;
function call(cmd, output) {
  const tcId = `t${++id}`;
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: tcId, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) } }] },
    { role: 'tool', tool_call_id: tcId, content: output },
  ];
}
const bad = (cmd) => call(cmd, 'Exit code: 1\nTraceback (most recent call last):');
const ok = (cmd) => call(cmd, 'Exit code: 0\nfine');

test('parses chat tool calls after the latest real user message', () => {
  const turn = parseChatTurn([
    { role: 'system', content: 'you are a coder' },
    { role: 'user', content: 'old' }, ...bad('make'),
    { role: 'user', content: [{ type: 'text', text: 'fix the build' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ...bad('pytest'), ...bad('pytest -x'), ...ok('cat a.py'),
    { role: 'assistant', content: 'thinking out loud' },
  ]);
  assert.equal(turn.userText, 'fix the build');
  assert.deepEqual(turn.steps.map((s) => [s.kind, s.failed]), [['verify', true], ['verify', true], ['read', false]]);
  assert.equal(turn.assistantMessages, 1);
});

test('chat failures escalate like Responses failures', () => {
  const turn = parseChatTurn([{ role: 'user', content: 'fix' }, ...bad('pytest'), ...bad('pytest -x')]);
  assert.equal(assess(turn, LADDER).target, 2);
});

test('effort is rewritten in the form the client used, injected only when asked', () => {
  assert.deepEqual(applyChatEffort({ model: 'm', reasoning_effort: 'low' }, 'high', false), { model: 'm', reasoning_effort: 'high' });
  assert.deepEqual(applyChatEffort({ reasoning: { effort: 'low', exclude: true } }, 'high', false), { reasoning: { effort: 'high', exclude: true } });
  assert.deepEqual(applyChatEffort({ model: 'm' }, 'medium', true), { model: 'm', reasoning: { effort: 'medium' } });
  assert.deepEqual(applyChatEffort({ model: 'm' }, 'medium', false), { model: 'm' });
});

test('chat session key is stable across steps of one conversation', () => {
  const first = { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'task A' }] };
  const later = { ...first, messages: [...first.messages, ...ok('ls')] };
  assert.equal(chatSessionKey(first, {}), chatSessionKey(later, {}));
  assert.notEqual(chatSessionKey(first, {}), chatSessionKey({ ...first, messages: [{ role: 'user', content: 'task B' }] }, {}));
  assert.equal(chatSessionKey({ ...first, user: 'u1' }, {}), 'u1');
});

test('OpenRouter keys go to OpenRouter', () => {
  const config = loadConfig({});
  assert.equal(upstreamBase(config, { authorization: 'Bearer sk-or-v1-abc' }), 'https://openrouter.ai/api/v1');
  assert.equal(upstreamBase(config, { authorization: 'Bearer sk-proj-abc' }), 'https://api.openai.com/v1');
});

async function chatHarness(reply) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      reply(res);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const logged = [];
  const config = loadConfig({ LAYA_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/v1`, LAYA_HOME: '.laya-test' });
  const { server, stats } = createProxy(config, { log: { write: (r) => logged.push(r) }, print: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { post, seen, logged, stats, close: () => { server.close(); upstream.close(); } };
}

test('proxy routes streamed chat completions and records reasoning tokens', async () => {
  const h = await chatHarness((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n');
    res.write('data: {"choices":[],"usage":{"completion_tokens":20,"completion_tokens_details":{"reasoning_tokens":12}}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const messages = [{ role: 'user', content: 'fix' }, ...bad('pytest'), ...bad('pytest -x')];
    const res = await h.post({ model: 'm', stream: true, reasoning_effort: 'low', messages });
    assert.match(await res.text(), /\[DONE\]/);
    assert.equal(h.seen[0].url, '/v1/chat/completions');
    assert.equal(h.seen[0].body.reasoning_effort, 'high');
    assert.deepEqual(h.seen[0].body.messages, messages);
    assert.equal(h.logged[0].api, 'chat');
    assert.equal(h.stats.reasoningTokens.high, 12);
  } finally {
    h.close();
  }
});

test('proxy reads usage from a non-streamed chat reply and leaves non-reasoning requests alone', async () => {
  const h = await chatHarness((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [], usage: { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } }));
  });
  try {
    await (await h.post({ model: 'm', reasoning: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(h.seen[0].body.reasoning.effort, 'low');
    assert.equal(h.stats.reasoningTokens.low, 3);

    await (await h.post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal('reasoning' in h.seen[1].body || 'reasoning_effort' in h.seen[1].body, false);
    assert.equal(h.logged.length, 1);
  } finally {
    h.close();
  }
});

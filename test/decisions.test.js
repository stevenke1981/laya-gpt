import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildState, buildQuestions, toAssessment, layaDecide, layaStopCheck } from '../src/decisions.js';
import { createRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const LADDER = ['low', 'medium', 'high'];
const turn = {
  userText: 'find bugs',
  steps: [
    { kind: 'read', command: 'rg foo', failed: false },
    { kind: 'verify', command: 'pytest', failed: true },
    { kind: 'verify', command: 'pytest', failed: true },
  ],
};
const answers = (score, stuck, confidence = 0.9) => ({
  effort: { type: 'score', score, confidence, probabilities: {}, legend: {} },
  stuck: { type: 'noul', noul: stuck },
});

test('state summarizes the trajectory; questions follow the ladder', () => {
  const s = buildState(turn, 'medium');
  assert.equal(s.next_generation, 4);
  assert.deepEqual(s.totals, { tool_calls: 3, failures: 2, consecutive_failures: 2, edits: 0 });
  assert.equal(s.recent_steps[2].status, 'failed');
  const q = buildQuestions(LADDER);
  assert.equal(q.effort.type, 'score');
  assert.equal(q.effort.criteria.length, 3);
  assert.match(q.effort.criteria[0], /^low:/);
  assert.deepEqual(Object.keys(q.stuck.criteria), ['true', 'false']);
  // One model only: no question about a stronger one.
  assert.deepEqual(Object.keys(q), ['effort', 'stuck']);
});

test('answers map to rung, hold and release', () => {
  assert.deepEqual(
    [toAssessment(answers(1.8, 0.9), LADDER, 0.3)].map((a) => [a.target, a.hold, a.release])[0], [2, 2, false]);
  assert.deepEqual(
    [toAssessment(answers(0.2, 0.1), LADDER, 0.3)].map((a) => [a.target, a.hold, a.release])[0], [0, 0, true]);
  assert.equal(toAssessment(answers(9, 0.6), LADDER, 0.3).target, 2);
  assert.throws(() => toAssessment(answers(1, 0.5, 0.1), LADDER, 0.3), /confidence/);
  assert.throws(() => toAssessment({ effort: { type: 'choice' } }, LADDER, 0.3), /unexpected/);
});

function decisionsServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      handler(res);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/api/alpha/decisions` })));
}

test('layaDecide posts a Decisions request and returns cost', async () => {
  const { server, seen, url } = await decisionsServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'gen-dec-1', model: 'typesafe/laya-1.14-20261014', answers: answers(1.1, 0.6), usage: { input_tokens: 400, output_tokens: 0, cost: 0.0000168 } }));
  });
  try {
    const d = await layaDecide(turn, { url, apiKey: 'or-test', model: 'typesafe/laya-1.14', timeoutMs: 2000, ladder: LADDER, minConfidence: 0.3, sessionId: 's1' });
    assert.deepEqual([d.target, d.hold, d.cost, d.stuck], [1, 1, 0.0000168, 0.6]);
    assert.equal(seen[0].headers.authorization, 'Bearer or-test');
    assert.equal(seen[0].body.model, 'typesafe/laya-1.14');
    assert.equal(seen[0].body.session_id, 's1');
    assert.deepEqual(Object.keys(seen[0].body.questions), ['effort', 'stuck']);
  } finally {
    server.close();
  }
});

const stopOpts = (url, extra = {}) => ({ url, apiKey: 'or-test', model: 'typesafe/laya-1.14', timeoutMs: 2000, ...extra });
const unfinishedReply = (noul, cost = 0.00003) => (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ answers: { unfinished: { type: 'noul', noul } }, usage: { cost } }));
};

test('layaStopCheck asks one unfinished question with the turn, final text and plan', async () => {
  const { server, seen, url } = await decisionsServer(unfinishedReply(0.82));
  try {
    const plan = { total: 3, done: 1, open: ['write tests', 'update docs'] };
    const r = await layaStopCheck(turn, plan, 'Next I will add tests.', stopOpts(url, { sessionId: 's2' }));
    assert.deepEqual(r, { unfinished: 0.82, reasons: ['laya unfinished 0.82'], cost: 0.00003 });
    assert.equal(seen[0].headers.authorization, 'Bearer or-test');
    assert.equal(seen[0].body.model, 'typesafe/laya-1.14');
    assert.equal(seen[0].body.session_id, 's2');
    assert.deepEqual(Object.keys(seen[0].body.questions), ['unfinished']);
    assert.equal(seen[0].body.questions.unfinished.type, 'noul');
    assert.match(seen[0].body.questions.unfinished.instructions, /ended its turn/);
    assert.deepEqual(seen[0].body.state.plan, plan);
    assert.equal(seen[0].body.state.final_message, 'Next I will add tests.');
    assert.equal(seen[0].body.state.totals.tool_calls, 3);
    assert.equal(seen[0].body.state.task, 'find bugs');
  } finally {
    server.close();
  }
});

test('layaStopCheck truncates the final message, sends a null plan and no session when absent', async () => {
  const { server, seen, url } = await decisionsServer(unfinishedReply(0.1));
  try {
    const r = await layaStopCheck(turn, null, 'x'.repeat(5000), stopOpts(url));
    assert.equal(r.unfinished, 0.1);
    assert.equal(seen[0].body.state.final_message.length, 2000);
    assert.equal(seen[0].body.state.plan, null);
    assert.equal('session_id' in seen[0].body, false);
  } finally {
    server.close();
  }
});

test('layaStopCheck throws on an HTTP error and on a non-number answer', async () => {
  const failing = await decisionsServer((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  try {
    await assert.rejects(layaStopCheck(turn, null, 'done', stopOpts(failing.url)), /Laya HTTP 500: boom/);
  } finally {
    failing.server.close();
  }
  const malformed = await decisionsServer(unfinishedReply('high'));
  try {
    await assert.rejects(layaStopCheck(turn, null, 'done', stopOpts(malformed.url)), /unexpected answer shape/);
  } finally {
    malformed.server.close();
  }
});

test('router falls back to heuristic when Laya errors', async () => {
  const { server, url } = await decisionsServer((res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }));
  });
  try {
    const config = loadConfig({ OPENROUTER_API_KEY: 'or-test', LAYA_DECISION_URL: url });
    assert.equal(config.mode, 'laya');
    const router = createRouter(config);
    const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
    const d = await router.route(body, 's', null);
    assert.equal(d.effort, 'low');
    assert.match(d.source, /laya failed: Laya HTTP 402: Insufficient credits/);
  } finally {
    server.close();
  }
});

test('config: laya is default only with a key, and explicit laya requires one', () => {
  assert.equal(loadConfig({}).mode, 'heuristic');
  assert.throws(() => loadConfig({ LAYA_MODE: 'laya' }), /OPENROUTER_API_KEY/);
  assert.throws(() => loadConfig({ OPENROUTER_API_KEY: 'k', LAYA_MIN_CONFIDENCE: '2' }), /LAYA_MIN_CONFIDENCE/);
});

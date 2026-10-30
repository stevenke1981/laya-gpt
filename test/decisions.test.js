import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  situation, effortCall, toAssessment, combineEffort, layaDecide, closingOf, layaStopCheck, resetLayaPause,
  layaCacheStats, resetLayaCache,
} from '../src/decisions.js';
import { createRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const LADDER = ['low', 'medium', 'high', 'xhigh'];
const step = (kind, command, failed) => ({ kind, command, failed });
const turn = {
  userText: 'find bugs',
  steps: [step('read', 'rg foo', false), step('verify', 'pytest', true), step('verify', 'pytest', true)],
};
const choice = (picked, probabilities) => ({ type: 'choice', choice: picked, probabilities, confidence: probabilities[picked] });
const effortAnswers = (picked, top, stuck) => ({
  effort: choice(picked, Object.fromEntries(LADDER.map((e) => [e, e === picked ? top : (1 - top) / 3]))),
  ...(stuck == null ? {} : { stuck: choice(stuck >= 0.5 ? 'stuck' : 'progressing', { stuck, progressing: 1 - stuck }) }),
});
const stopAnswers = (end, work) => {
  const top = (p) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
  return { end: choice(top(end), end), work: choice(top(work), work) };
};

test('situation turns the last step into one coarse phrase', () => {
  assert.equal(situation([step('read', 'cat a', false)]), 'read a file, it worked');
  assert.equal(situation([step('edit', 'apply_patch', false)]), 'edited code, it worked');
  assert.equal(situation([step('exec', 'npm i', null)]), 'ran a command, still running');
  const reads = ['a', 'b', 'c', 'd', 'e'].map((f) => step('read', `cat ${f}`, false));
  assert.equal(situation([step('edit', 'apply_patch', false), ...reads]), 'read 5 files since the last edit');
  assert.equal(situation([step('verify', 'pytest', true)]), 'ran the tests or build, it failed; first failure');
  assert.equal(situation(turn.steps), 'ran the tests or build, it failed; 2 failures in a row; the same failing command was repeated');
  const four = ['a', 'b', 'c', 'd'].map((c) => step('exec', `make ${c}`, true));
  assert.equal(situation(four), 'ran a command, it failed; 4 or more failures in a row');
});

test('effortCall asks about the request on a new turn and about the last step after', () => {
  const fresh = effortCall({ userText: 'x'.repeat(2000), steps: [] }, LADDER);
  assert.deepEqual(Object.keys(fresh.state), ['request']);
  assert.equal(fresh.state.request.length, 800);
  assert.deepEqual(Object.keys(fresh.questions), ['effort']);
  assert.equal(fresh.questions.effort.type, 'choice');
  // One option per rung and no catch-all option such as none or other.
  assert.deepEqual(Object.keys(fresh.questions.effort.criteria), LADDER);

  const later = effortCall(turn, ['low', 'medium', 'high']);
  assert.deepEqual(later.state, { last_step: situation(turn.steps) });
  assert.deepEqual(Object.keys(later.questions), ['effort', 'stuck']);
  assert.deepEqual(Object.keys(later.questions.effort.criteria), ['low', 'medium', 'high']);
  assert.deepEqual(Object.keys(later.questions.stuck.criteria), ['stuck', 'progressing']);
  assert.equal(later.questions.stuck.type, 'choice');
});

test('answers map to rung, hold and release; laya abstains below the confidence floor', () => {
  const pick = (a) => [a.target, a.hold, a.release];
  assert.deepEqual(pick(toAssessment(effortAnswers('high', 0.8, 0.9), LADDER, 0.5)), [2, 2, false]);
  assert.deepEqual(pick(toAssessment(effortAnswers('medium', 0.7, 0.6), LADDER, 0.5)), [1, 1, false]);
  assert.deepEqual(pick(toAssessment(effortAnswers('low', 0.9, 0.1), LADDER, 0.5)), [0, 0, true]);
  // A new turn has no stuck question.
  assert.deepEqual(pick(toAssessment(effortAnswers('xhigh', 0.6), LADDER, 0.5)), [3, 0, false]);
  assert.match(toAssessment(effortAnswers('high', 0.8, 0.9), LADDER, 0.5).reasons.join(';'), /laya high 0.80;stuck 0.90/);
  assert.throws(() => toAssessment(effortAnswers('high', 0.4), LADDER, 0.5), /abstained: high 0.40 < 0.5/);
  assert.throws(() => toAssessment({ effort: { type: 'score', score: 1 } }, LADDER, 0.5), /unexpected/);
  assert.throws(() => toAssessment({ effort: choice('turbo', { turbo: 1 }) }, LADDER, 0.5), /unexpected/);
});

test('combineEffort: laya leads a new turn, and inside a turn it may only raise the effort', () => {
  const laya = { target: 1, hold: 0, release: false, reasons: ['laya medium 0.70'] };
  const rules = { target: 2, hold: 2, reasons: ['2 failures in a row'] };
  assert.equal(combineEffort(laya, rules, true), laya);
  assert.deepEqual(combineEffort(laya, rules, false), { target: 2, hold: 2, reasons: ['2 failures in a row', 'laya medium 0.70'] });
  const higher = { ...laya, target: 3 };
  assert.equal(combineEffort(higher, rules, false), higher);
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
const reply = (answers) => (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ answers, usage: { latency_ms: 40 } }));
};
const opts = (url, extra = {}) => ({ url, model: 'english', timeoutMs: 2000, ladder: LADDER, minConfidence: 0.5, ...extra });

test('layaDecide posts a Decisions request, with a bearer token only when one is set', async () => {
  const { server, seen, url } = await decisionsServer(reply(effortAnswers('high', 0.78, 0.6)));
  try {
    const d = await layaDecide(turn, opts(url));
    assert.deepEqual([d.target, d.hold, d.cost, d.stuck], [2, 1, null, 0.6]);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.deepEqual(Object.keys(seen[0].body).sort(), ['model', 'questions', 'state']);
    assert.equal(seen[0].body.model, 'english');
    await layaDecide(turn, opts(url, { apiKey: 'local-secret' }));
    assert.equal(seen[1].headers.authorization, 'Bearer local-secret');
  } finally {
    server.close();
  }
});

test('closingOf keeps the end of the text, where the closing question sits', () => {
  assert.equal(closingOf('  done.  '), 'done.');
  assert.equal(closingOf(`${'a'.repeat(600)}Shall I go on?`).length, 500);
  assert.match(closingOf(`${'a'.repeat(600)}Shall I go on?`), /Shall I go on\?$/);
  assert.equal(closingOf(null), '');
});

test('layaStopCheck: hard stop rules decide without asking laya', async () => {
  const { server, seen, url } = await decisionsServer(reply(stopAnswers({ will_continue: 0.9, done: 0.05, needs_user: 0.05 }, { in_progress: 0.9, complete: 0.1 })));
  try {
    assert.equal((await layaStopCheck({ userText: 'hi', steps: [] }, null, 'Next I will…', opts(url))).unfinished, 0);
    assert.equal((await layaStopCheck(turn, null, 'Please provide your API key.', opts(url))).unfinished, 0.1);
    const plan = { total: 3, done: 1, open: ['write tests', 'update docs'] };
    assert.deepEqual(await layaStopCheck(turn, plan, 'All done.', opts(url)), { unfinished: 0.9, reasons: ['plan 1/3 done'], cost: null });
    assert.equal(seen.length, 0);
  } finally {
    server.close();
  }
});

test('layaStopCheck: laya reads the closing text, and the rules still catch a permission question', async () => {
  let answers;
  const { server, seen, url } = await decisionsServer((res) => reply(answers)(res));
  try {
    answers = stopAnswers({ will_continue: 0.7, done: 0.2, needs_user: 0.1 }, { in_progress: 0.6, complete: 0.4 });
    const r = await layaStopCheck(turn, null, 'Config is updated; the router comes after this.', opts(url));
    assert.deepEqual(r, { unfinished: 0.7, reasons: ['laya will_continue 0.70, in progress 0.60'], cost: null });
    assert.deepEqual(seen[0].body.state, { closing: 'Config is updated; the router comes after this.' });
    assert.deepEqual(Object.keys(seen[0].body.questions), ['end', 'work']);
    assert.deepEqual(Object.keys(seen[0].body.questions.end.criteria), ['will_continue', 'done', 'needs_user']);

    // A progress report that lists what remains: "work" catches it although "end" says done.
    answers = stopAnswers({ will_continue: 0.15, done: 0.7, needs_user: 0.15 }, { in_progress: 0.78, complete: 0.22 });
    assert.equal((await layaStopCheck(turn, null, 'Parser rewritten. Remaining: lexer, docs.', opts(url))).unfinished, 0.78);

    // A finished summary: "end" is sure it says done, so "work"'s in progress is ignored.
    answers = stopAnswers({ will_continue: 0.005, done: 0.99, needs_user: 0.005 }, { in_progress: 0.63, complete: 0.37 });
    // (This turn ends on a failing step, so the rules' own 0.5 is what remains.)
    assert.equal((await layaStopCheck(turn, null, 'Summary: rewrote the lexer, added 12 tests (all pass).', opts(url))).unfinished, 0.5);

    // laya says done, but the agent asked whether to go on: the rules' 0.75 stands.
    answers = stopAnswers({ will_continue: 0.2, done: 0.7, needs_user: 0.1 }, { in_progress: 0.3, complete: 0.7 });
    const asked = await layaStopCheck(turn, null, 'Two modules done. Would you like me to continue with the rest?', opts(url));
    assert.equal(asked.unfinished, 0.75);
    assert.match(asked.reasons.join(';'), /asks permission to continue/);

    // laya says the agent needs the user: only laya's "will continue" counts, not the rules.
    answers = stopAnswers({ will_continue: 0.2, done: 0.2, needs_user: 0.6 }, { in_progress: 0.7, complete: 0.3 });
    assert.equal((await layaStopCheck(turn, null, 'Which database should I target, shall I pick one?', opts(url))).unfinished, 0.2);
  } finally {
    server.close();
  }
});

test('layaStopCheck throws on an HTTP error and on an unexpected answer', async () => {
  const failing = await decisionsServer((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom', code: 'inference_failed' } }));
  });
  try {
    await assert.rejects(layaStopCheck(turn, null, 'done', opts(failing.url)), /laya HTTP 500: boom/);
  } finally {
    failing.server.close();
  }
  const malformed = await decisionsServer(reply({ end: { type: 'noul', noul: 0.9 } }));
  try {
    await assert.rejects(layaStopCheck(turn, null, 'done', opts(malformed.url)), /unexpected answer shape/);
  } finally {
    malformed.server.close();
  }
});

test('router falls back to the rules when laya errors', async () => {
  const { server, url } = await decisionsServer((res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } }));
  });
  try {
    const config = loadConfig({ LAYA_DECISION_URL: url });
    assert.equal(config.mode, 'laya');
    const router = createRouter(config);
    const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };
    const d = await router.route(body, 's', null);
    assert.equal(d.effort, 'low');
    assert.match(d.source, /laya failed: laya HTTP 401: missing or invalid bearer token/);
  } finally {
    server.close();
  }
});

test('config: laya is the default mode and needs no key; the local server is the default', () => {
  const config = loadConfig({});
  assert.deepEqual(
    [config.mode, config.decisionUrl, config.decisionModel, config.decisionKey, config.decisionTimeoutMs, config.minConfidence],
    ['laya', 'http://127.0.0.1:8100/api/alpha/decisions', 'multilingual', '', 2000, 0.5],
  );
  assert.equal(loadConfig({ LAYA_API_KEY: 'k' }).decisionKey, 'k');
  assert.throws(() => loadConfig({ LAYA_MIN_CONFIDENCE: '2' }), /LAYA_MIN_CONFIDENCE/);
  assert.throws(() => loadConfig({ LAYA_DECISION_TIMEOUT_MS: '-1' }), /LAYA_DECISION_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ LAYA_DECISION_TIMEOUT_MS: '0' }), /LAYA_DECISION_TIMEOUT_MS must be at least 1/);
});

test('a laya that times out is paused, so later calls fail at once; an answer ends the pause', async () => {
  let hang = true;
  const { server, seen, url } = await decisionsServer((res) => {
    if (!hang) reply(effortAnswers('high', 0.8, 0.6))(res);
  });
  try {
    await assert.rejects(layaDecide(turn, opts(url, { timeoutMs: 50 })), { name: 'TimeoutError' });
    const start = Date.now();
    await assert.rejects(layaDecide(turn, opts(url, { timeoutMs: 50 })), /laya paused for \d+ s after a timeout/);
    assert.ok(Date.now() - start < 40);
    assert.equal(seen.length, 1);
    resetLayaPause();
    hang = false;
    assert.equal((await layaDecide(turn, opts(url))).target, 2);
  } finally {
    resetLayaPause();
    server.closeAllConnections();
    server.close();
  }
});

test('identical laya calls are answered from the cache; errors are not cached', async () => {
  resetLayaCache();
  let fail = true;
  const { server, seen, url } = await decisionsServer((res) => {
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'loading' } }));
    }
    reply(effortAnswers('high', 0.78, 0.6))(res);
  });
  try {
    await assert.rejects(layaDecide(turn, opts(url, { cacheSize: 8 })), /laya HTTP 500/);
    fail = false;
    const first = await layaDecide(turn, opts(url, { cacheSize: 8 }));
    assert.ok(!first.reasons.includes('cached'));
    // Same phrase and questions: no new request; concurrent identical calls share one.
    const [a, b] = await Promise.all([layaDecide(turn, opts(url, { cacheSize: 8 })), layaDecide(turn, opts(url, { cacheSize: 8 }))]);
    assert.deepEqual([a.target, b.target], [first.target, first.target]);
    assert.ok(a.reasons.includes('cached'));
    assert.equal(seen.length, 2);
    // A different checkpoint is a different call.
    await layaDecide(turn, opts(url, { cacheSize: 8, model: 'multilingual' }));
    assert.equal(seen.length, 3);
    assert.deepEqual(layaCacheStats(), { hits: 2, misses: 3, entries: 2 });
    // No cacheSize: every call asks laya.
    await layaDecide(turn, opts(url));
    assert.equal(seen.length, 4);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('the decision cache keeps at most cacheSize entries, least recently used out first', async () => {
  resetLayaCache();
  const { server, seen, url } = await decisionsServer(reply(effortAnswers('medium', 0.8)));
  const ask = (text) => layaDecide({ userText: text, steps: [] }, opts(url, { cacheSize: 2 }));
  try {
    await ask('a');
    await ask('b');
    await ask('a');
    await ask('c');
    assert.equal(seen.length, 3);
    await ask('a');
    assert.equal(seen.length, 3);
    await ask('b');
    assert.equal(seen.length, 4);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('layaStopCheck reuses a cached answer for the same closing text', async () => {
  resetLayaCache();
  const answers = stopAnswers({ will_continue: 0.7, done: 0.2, needs_user: 0.1 }, { in_progress: 0.6, complete: 0.4 });
  const { server, seen, url } = await decisionsServer(reply(answers));
  const work = { userText: 'x', steps: [step('edit', 'apply_patch', false)] };
  try {
    const first = await layaStopCheck(work, null, 'Two modules left.', opts(url, { cacheSize: 4 }));
    const again = await layaStopCheck(work, null, 'Two modules left.', opts(url, { cacheSize: 4 }));
    assert.equal(seen.length, 1);
    assert.equal(again.unfinished, first.unfinished);
    assert.match(again.reasons[0], /\(cached\)$/);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('config: the decision cache holds 256 entries by default; 0 turns it off', () => {
  assert.equal(loadConfig({}).decisionCacheSize, 256);
  assert.equal(loadConfig({ LAYA_DECISION_CACHE: '0' }).decisionCacheSize, 0);
});

test('an answer-less laya reply is not cached', async () => {
  resetLayaCache();
  let empty = true;
  const { server, seen, url } = await decisionsServer((res) => (empty ? reply(null)(res) : reply(effortAnswers('high', 0.8, 0.6))(res)));
  try {
    await assert.rejects(layaDecide(turn, opts(url, { cacheSize: 4 })), /unexpected answer shape/);
    empty = false;
    assert.equal((await layaDecide(turn, opts(url, { cacheSize: 4 }))).target, 2);
    assert.equal(seen.length, 2);
  } finally {
    resetLayaCache();
    server.close();
  }
});

const freshTurn = { userText: 'find bugs', steps: [] };

// A transient bad HTTP 200 must not keep later callers from seeing a recovered server.
const malformedAnswers = [
  ['empty answers', {}],
  ['array answers', []],
  ['missing effort answer', { unrelated: choice('high', { high: 1 }) }],
  ['wrong answer type', { effort: { type: 'score', score: 0.8 } }],
  ['array answer', { effort: [] }],
  ['unknown choice', { effort: choice('turbo', { turbo: 1 }) }],
  ['missing probabilities', { effort: { type: 'choice', choice: 'high' } }],
  ['array probabilities', { effort: { type: 'choice', choice: 'high', probabilities: [] } }],
  ['missing option probability', { effort: choice('high', { high: 0.8 }) }],
  ['string probability', { effort: choice('high', { low: '0.1', medium: 0.1, high: 0.7, xhigh: 0.1 }) }],
  ['null probability', { effort: choice('high', { low: null, medium: 0.1, high: 0.8, xhigh: 0.1 }) }],
  ['negative probability', { effort: choice('high', { low: -0.1, medium: 0.1, high: 0.9, xhigh: 0.1 }) }],
  ['probability above one', { effort: choice('high', { low: 0, medium: 0, high: 1.1, xhigh: 0 }) }],
];

for (const [name, invalid] of malformedAnswers) {
  test(`decision cache rejects ${name}, then accepts and caches a recovered reply`, async () => {
    resetLayaCache();
    let answers = invalid;
    const { server, seen, url } = await decisionsServer((res) => reply(answers)(res));
    const options = opts(url, { cacheSize: 4 });
    try {
      await assert.rejects(layaDecide(freshTurn, options), /unexpected answer shape/);
      assert.equal(layaCacheStats().entries, 0);
      answers = effortAnswers('high', 0.8);
      assert.equal((await layaDecide(freshTurn, options)).target, 2);
      assert.ok((await layaDecide(freshTurn, options)).reasons.includes('cached'));
      assert.equal(seen.length, 2);
    } finally {
      resetLayaCache();
      server.close();
    }
  });
}

test('all requested effort and stop answers are validated before caching', async () => {
  resetLayaCache();
  let answers = effortAnswers('high', 0.8); // An in-turn request also asks about being stuck.
  const { server, seen, url } = await decisionsServer((res) => reply(answers)(res));
  const options = opts(url, { cacheSize: 4 });
  try {
    await assert.rejects(layaDecide(turn, options), /unexpected answer shape/);
    assert.equal(layaCacheStats().entries, 0);
    answers = { ...effortAnswers('high', 0.8), stuck: choice('unknown', { stuck: 0.6, progressing: 0.4 }) };
    await assert.rejects(layaDecide(turn, options), /unexpected answer shape/);
    answers = effortAnswers('high', 0.8, 0.6);
    assert.equal((await layaDecide(turn, options)).stuck, 0.6);

    const validStop = stopAnswers({ will_continue: 0.7, done: 0.2, needs_user: 0.1 }, { in_progress: 0.6, complete: 0.4 });
    const askStop = () => layaStopCheck(turn, null, 'Two modules left.', options);
    answers = { end: validStop.end };
    await assert.rejects(askStop(), /unexpected answer shape/);
    answers = { ...validStop, work: choice('complete', { in_progress: 'bad', complete: 0.4 }) };
    await assert.rejects(askStop(), /unexpected answer shape/);
    answers = validStop;
    assert.equal((await askStop()).unfinished, 0.7);
    assert.match((await askStop()).reasons[0], /\(cached\)$/);
    assert.equal(seen.length, 6);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('an unsolicited malformed stuck answer cannot poison the fresh-turn cache', async () => {
  resetLayaCache();
  let answers = { ...effortAnswers('high', 0.7), stuck: choice('bad', { stuck: 0.5, progressing: 0.5 }) };
  const { server, seen, url } = await decisionsServer((res) => reply(answers)(res));
  const options = opts(url, { cacheSize: 4 });
  try {
    await assert.rejects(layaDecide(freshTurn, options), /unexpected answer shape/);
    assert.equal(layaCacheStats().entries, 0);
    // toAssessment also consumes an optional stuck answer on a new turn, even though
    // the request asked only about effort. A recovered answer must reach that parser.
    answers = effortAnswers('high', 0.7, 0.6);
    assert.equal((await layaDecide(freshTurn, options)).stuck, 0.6);
    assert.ok((await layaDecide(freshTurn, options)).reasons.includes('cached'));
    assert.equal(seen.length, 2);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('valid low-confidence answers remain cached and abstain for each caller', async () => {
  resetLayaCache();
  const { server, seen, url } = await decisionsServer(reply(effortAnswers('high', 0.4)));
  try {
    const options = opts(url, { cacheSize: 4 });
    await assert.rejects(layaDecide(freshTurn, options), /abstained/);
    await assert.rejects(layaDecide(freshTurn, options), /abstained/);
    assert.equal(seen.length, 1);
    // Confidence belongs to the caller's policy, not the cached answer's shape.
    assert.equal((await layaDecide(freshTurn, { ...options, minConfidence: 0.3 })).target, 2);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('routing returns to laya after a malformed reply instead of reusing the fallback', async () => {
  resetLayaCache();
  let answers = {};
  const { server, seen, url } = await decisionsServer((res) => reply(answers)(res));
  const router = createRouter(loadConfig({ LAYA_DECISION_URL: url }));
  const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find bugs' }] }] };
  try {
    assert.match((await router.route(body, 'recovery', null)).source, /heuristic \(laya failed:/);
    answers = effortAnswers('high', 0.8);
    const recovered = await router.route(body, 'recovery', null);
    assert.equal(recovered.source, 'laya');
    assert.equal(recovered.effort, 'high');
    assert.equal((await router.route(body, 'recovery', null)).source, 'laya');
    assert.equal(seen.length, 2);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('choice validation rejects nonfinite values and permits unused response metadata', async () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const invalid = effortAnswers('high', 0.8);
    invalid.effort.probabilities.low = value;
    assert.throws(() => toAssessment(invalid, LADDER, 0.5), /unexpected answer shape/);
  }
  resetLayaCache();
  const answers = effortAnswers('high', 0.8);
  answers.metadata = { latency_ms: 40 };
  answers.effort.probabilities.extra = 0;
  const { server, seen, url } = await decisionsServer(reply(answers));
  try {
    const options = opts(url, { cacheSize: 4 });
    assert.equal((await layaDecide(freshTurn, options)).target, 2);
    assert.ok((await layaDecide(freshTurn, options)).reasons.includes('cached'));
    assert.equal(seen.length, 1);
  } finally {
    resetLayaCache();
    server.close();
  }
});

test('cache-disabled calls still reject incomplete answers and retry after recovery', async () => {
  resetLayaCache();
  let answers = effortAnswers('high', 0.8);
  const { server, seen, url } = await decisionsServer((res) => reply(answers)(res));
  try {
    await assert.rejects(layaDecide(turn, opts(url, { cacheSize: 0 })), /unexpected answer shape/);
    answers = effortAnswers('high', 0.8, 0.6);
    await layaDecide(turn, opts(url, { cacheSize: 0 }));
    await layaDecide(turn, opts(url, { cacheSize: 0 }));
    assert.equal(seen.length, 3);
    assert.deepEqual(layaCacheStats(), { hits: 0, misses: 0, entries: 0 });
  } finally {
    resetLayaCache();
    server.close();
  }
});

async function until(check) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('timed out waiting for decision request');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('concurrent identical calls share validation, evict a bad reply, and share recovery', async () => {
  resetLayaCache();
  const pending = [];
  const { server, seen, url } = await decisionsServer((res) => pending.push(res));
  const options = opts(url, { cacheSize: 4 });
  const ask = () => layaDecide(freshTurn, options);
  try {
    const failed = Promise.allSettled(Array.from({ length: 8 }, ask));
    await until(() => pending.length === 1);
    reply({})(pending[0]);
    const results = await failed;
    assert.ok(results.every((r) => r.status === 'rejected' && /unexpected answer shape/.test(r.reason.message)));
    assert.equal(layaCacheStats().entries, 0);
    assert.equal(seen.length, 1);

    const recovered = Promise.all(Array.from({ length: 8 }, ask));
    await until(() => pending.length === 2);
    reply(effortAnswers('high', 0.8))(pending[1]);
    assert.ok((await recovered).every((r) => r.target === 2));
    assert.ok((await ask()).reasons.includes('cached'));
    assert.equal(seen.length, 2);
  } finally {
    resetLayaCache();
    server.closeAllConnections();
    server.close();
  }
});

test('a failed evicted request cannot remove a newer entry for the same key', async () => {
  resetLayaCache();
  const pending = [];
  const { server, seen, url } = await decisionsServer((res) => pending.push(res));
  const ask = (text) => layaDecide({ userText: text, steps: [] }, opts(url, { cacheSize: 1 }));
  try {
    const stale = assert.rejects(ask('a'), /unexpected answer shape/);
    await until(() => pending.length === 1);
    const other = ask('b');
    await until(() => pending.length === 2);
    reply(effortAnswers('high', 0.8))(pending[1]);
    await other;
    const current = ask('a');
    await until(() => pending.length === 3);
    reply({})(pending[0]);
    await stale;
    reply(effortAnswers('high', 0.8))(pending[2]);
    await current;
    assert.ok((await ask('a')).reasons.includes('cached'));
    assert.equal(seen.length, 3);
  } finally {
    resetLayaCache();
    server.closeAllConnections();
    server.close();
  }
});

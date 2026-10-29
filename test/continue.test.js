import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { formatContinue } from '../src/log.js';

// Every test runs against a local upstream; the decision and stop calls are injected,
// so nothing leaves the machine. The defaults fail loudly rather than reach the network.
const ROUTE = async () => ({ target: 0, hold: 0, release: true, stuck: 0, reasons: ['test'], cost: null });
const NO_NETWORK = async () => {
  throw new Error('no network in tests');
};
const LAYA_ON = { LAYA_MODE: 'laya' };
const PROMISE = 'Next I will add tests.';
const DONE = 'All tests pass and the work is done.';
const USAGE = { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 7 } };

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const messageItem = (id, text) => ({
  id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }],
});

// The events of one generation; `output` decides whether the turn ended (no client tool call).
function answer(id, text, output = [messageItem(`msg_${id}`, text)]) {
  return [
    ev('response.created', { response: { id } }),
    ev('response.in_progress', { response: { id } }),
    ev('response.output_text.delta', { delta: text }),
    ...output.map((item) => ev('response.output_item.done', { item })),
    ev('response.completed', { response: { id, output, usage: USAGE } }),
  ];
}
const sse = (events) => ({ body: events.join('') });
// A generation whose usage is told apart from the others, to see which one the log keeps.
const withUsage = (events, outputTokens) => events.map((e) => e.replace(/"output_tokens":9/, `"output_tokens":${outputTokens}`));

const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const shellStep = (callId) => [
  { type: 'function_call', name: 'shell', call_id: callId, arguments: JSON.stringify({ command: ['node', '--test'] }) },
  { type: 'function_call_output', call_id: callId, output: 'Exit code: 0\nok' },
];
const planStep = (plan) => [
  { type: 'function_call', name: 'update_plan', call_id: 'p1', arguments: JSON.stringify({ plan }) },
  { type: 'function_call_output', call_id: 'p1', output: 'Plan updated' },
];
const request = (input, extra = {}) => ({
  model: 'gpt-x', instructions: 'SYSTEM', input, reasoning: { effort: 'high', summary: 'auto' },
  stream: true, prompt_cache_key: 'sess-1', ...extra,
});
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function until(check, ms = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// `replies[i]` answers the i-th upstream request; the last reply repeats.
async function start({ env = {}, deps = {}, replies }) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
      res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'text/event-stream' });
      res.end(reply.body);
    });
  });
  const upPort = await listen(upstream);
  const logged = [];
  const printed = [];
  const config = loadConfig({ LAYA_UPSTREAM: `http://127.0.0.1:${upPort}/base`, LAYA_HOME: '.laya-test', ...env });
  const { server, stats } = createProxy(config, {
    decideFn: ROUTE,
    stopCheckFn: NO_NETWORK,
    ...deps,
    log: { write: (r) => logged.push(r) },
    print: (s) => printed.push(stripAnsi(s)),
  });
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    logged,
    printed,
    stats,
    close: () => {
      server.close();
      upstream.close();
    },
  };
}

function post(h, body, path = '/v1/responses') {
  return fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify(body),
  });
}

const HEURISTIC = { LAYA_MODE: 'heuristic' };

test('a turn that stops on a promise is resumed once, and the client sees one stream', async () => {
  const first = answer('r1', PROMISE);
  const second = answer('r2', DONE);
  const h = await start({ env: HEURISTIC, replies: [sse(first), sse(second)] });
  try {
    const input = [user('fix the parser'), ...shellStep('k1')];
    const res = await post(h, request(input));

    assert.equal(res.status, 200);
    // The first completed event is held; the second response's created and in_progress are dropped,
    // and the completed event that ends the stream carries the first id and both outputs.
    const terminal = ev('response.completed', { response: { id: 'r1', output: [messageItem('msg_r1', PROMISE), messageItem('msg_r2', DONE)], usage: USAGE } });
    assert.equal(await res.text(), [...first.slice(0, -1), ...second.slice(2, -1), terminal].join(''));
    assert.equal(h.seen.length, 2);
    assert.equal(h.seen[1].url, '/base/responses');
    assert.equal(h.seen[1].headers.authorization, 'Bearer sk-test');

    await until(() => h.logged.length === 1);
    assert.equal(h.logged[0].status, 200);
    assert.deepEqual(h.logged[0].continues, [{
      n: 1, effort: 'medium', unfinished: 0.75, source: 'heuristic', reasons: ['promises more work'],
    }]);
    assert.equal(h.stats.continued, 1);
    assert.deepEqual(h.printed.filter((s) => s.startsWith('Laya  RESUME')).map((s) => s.split('\n')[0]), [
      'Laya  RESUME #1 → MEDIUM  ✓ APPLIED',
    ]);

    const health = await (await fetch(`${h.base}/laya/health`)).json();
    assert.equal(health.stats.continued, 1);
    assert.equal(health.stats.nudged, 0);
  } finally {
    h.close();
  }
});

test('the continuation replays the output without ids, adds the [laya] developer message and a higher effort', async () => {
  const h = await start({ env: HEURISTIC, replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))] });
  try {
    const input = [user('fix the parser'), ...shellStep('k1')];
    await (await post(h, request(input))).text();

    const first = h.seen[0].body;
    const cont = h.seen[1].body;
    assert.equal(first.reasoning.effort, 'low', 'the first generation runs at the routed effort');
    assert.equal(cont.reasoning.effort, 'medium', 'the resumed generation climbs one rung');
    assert.deepEqual(cont.input.slice(0, input.length), input, 'the prior input is kept in order');
    assert.deepEqual(cont.input[input.length], {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PROMISE, annotations: [] }],
    });
    assert.equal('id' in cont.input[input.length], false);
    const developer = cont.input.at(-1);
    assert.equal(developer.role, 'developer');
    assert.match(developer.content[0].text, /^\[laya\] You ended your turn but the task is not finished \(promises more work\)\./);
    assert.equal(cont.model, 'gpt-x');
    assert.equal(cont.prompt_cache_key, 'sess-1');
  } finally {
    h.close();
  }
});

test('the decision log keeps the usage of the last generation and the reasoning tokens it reports', async () => {
  const h = await start({
    env: HEURISTIC,
    replies: [sse(withUsage(answer('r1', PROMISE), 11)), sse(withUsage(answer('r2', DONE), 22))],
  });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    await until(() => h.logged.length === 1);
    assert.equal(h.logged[0].usage.output_tokens, 22);
    assert.equal(h.logged[0].usage.output_tokens_details.reasoning_tokens, 7);
    assert.equal(h.stats.reasoningTokens.low, 7, 'reasoning tokens are counted under the routed effort');
  } finally {
    h.close();
  }
});

test('chained resumes stop at LAYA_MAX_CONTINUES', async () => {
  const rounds = [answer('r1', PROMISE), answer('r2', PROMISE), answer('r3', PROMISE)];
  const h = await start({ env: { ...HEURISTIC, LAYA_MAX_CONTINUES: '2' }, replies: rounds.map(sse) });
  try {
    const res = await post(h, request([user('fix the parser'), ...shellStep('k1')]));

    const outputs = [1, 2, 3].map((n) => messageItem(`msg_r${n}`, PROMISE));
    const terminal = ev('response.completed', { response: { id: 'r1', output: outputs, usage: USAGE } });
    assert.equal(await res.text(), [...rounds[0].slice(0, -1), ...rounds[1].slice(2, -1), ...rounds[2].slice(2, -1), terminal].join(''));
    assert.equal(h.seen.length, 3);
    assert.deepEqual(h.seen.map((s) => s.body.reasoning.effort), ['low', 'medium', 'high']);
    await until(() => h.logged.length === 1);
    assert.deepEqual(h.logged[0].continues.map((c) => [c.n, c.effort]), [[1, 'medium'], [2, 'high']]);
    assert.equal(h.stats.continued, 2);
  } finally {
    h.close();
  }
});

test('no resume when the generation ends with a client tool call', async () => {
  const output = [messageItem('msg_r1', PROMISE), { type: 'function_call', call_id: 'k2', name: 'shell', arguments: '{"command":["node","--test"]}', status: 'completed' }];
  const first = answer('r1', PROMISE, output);
  const h = await start({ env: HEURISTIC, replies: [sse(first)] });
  try {
    const res = await post(h, request([user('fix the parser'), ...shellStep('k1')]));
    assert.equal(await res.text(), first.join(''));
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('no resume when the request is not a stream', async () => {
  const json = JSON.stringify({ id: 'r1', object: 'response', output: [messageItem('msg_r1', PROMISE)], usage: USAGE });
  const h = await start({ env: HEURISTIC, replies: [{ type: 'application/json', body: json }] });
  try {
    const res = await post(h, request([user('fix the parser'), ...shellStep('k1')], { stream: false }));
    assert.equal(await res.text(), json);
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('no resume for a turn without steps or a plan, even when the answer promises more', async () => {
  const h = await start({ env: HEURISTIC, replies: [sse(answer('r1', PROMISE))] });
  try {
    await (await post(h, request([user('what is a closure?')]))).text();
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('no resume with LAYA_CONTINUE=off', async () => {
  const h = await start({ env: { ...HEURISTIC, LAYA_CONTINUE: 'off' }, replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))] });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('no resume when the heuristic scores the stop below the threshold', async () => {
  const h = await start({ env: HEURISTIC, replies: [sse(answer('r1', DONE)), sse(answer('r2', DONE))] });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('laya decides the stop: a low score releases a turn the heuristic would resume', async () => {
  const calls = [];
  const h = await start({
    env: LAYA_ON,
    deps: {
      stopCheckFn: async (turn, plan, text, opts) => {
        calls.push({ steps: turn.steps.length, plan, text, opts });
        return { unfinished: 0.2, reasons: ['laya unfinished 0.20'], cost: null };
      },
    },
    replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))],
  });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    assert.equal(h.seen.length, 1);
    assert.deepEqual(calls, [{
      steps: 1,
      plan: null,
      text: PROMISE,
      opts: {
        url: 'http://127.0.0.1:8100/api/alpha/decisions', apiKey: '', model: 'multilingual', timeoutMs: 2000, cacheSize: 256,
      },
    }]);
  } finally {
    h.close();
  }
});

test('a laya score above the threshold resumes with source laya', async () => {
  let judged = 0;
  const h = await start({
    env: LAYA_ON,
    deps: {
      // Once above the threshold, then done: the second round is released.
      stopCheckFn: async () => (judged++ === 0
        ? { unfinished: 0.8, reasons: ['laya unfinished 0.80'], cost: 0.0004 }
        : { unfinished: 0.1, reasons: ['laya unfinished 0.10'], cost: null }),
    },
    replies: [sse(answer('r1', DONE)), sse(answer('r2', DONE))],
  });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    await until(() => h.logged.length === 1);
    assert.equal(h.seen.length, 2);
    assert.deepEqual(h.logged[0].continues, [{
      n: 1, effort: 'medium', unfinished: 0.8, source: 'laya', reasons: ['laya unfinished 0.80'],
    }]);
  } finally {
    h.close();
  }
});

test('a failed laya stop check falls back to the heuristic and says so', async () => {
  const h = await start({
    env: LAYA_ON,
    deps: { stopCheckFn: async () => { throw new Error('timeout'); } },
    replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))],
  });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    await until(() => h.logged.length === 1);
    assert.equal(h.seen.length, 2);
    assert.equal(h.logged[0].continues[0].source, 'heuristic (laya failed: timeout)');
    assert.equal(h.logged[0].continues[0].unfinished, 0.75);
  } finally {
    h.close();
  }
});

test('a failed continuation (HTTP 500) releases the held event', async () => {
  const first = answer('r1', PROMISE);
  const h = await start({ env: HEURISTIC, replies: [sse(first), { status: 500, type: 'text/plain', body: 'overloaded' }] });
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => {
    stderr.push(String(s));
    return true;
  };
  try {
    const res = await post(h, request([user('fix the parser'), ...shellStep('k1')]));
    assert.equal(await res.text(), first.join(''), 'the client gets the first generation as it was, completed included');
    assert.equal(h.seen.length, 2);
    await until(() => h.logged.length === 1);
    assert.equal('continues' in h.logged[0], false);
    assert.equal(h.stats.continued, 0);
    assert.ok(stderr.some((s) => s.includes('resume #1 failed: HTTP 500')));
  } finally {
    process.stderr.write = write;
    h.close();
  }
});

test('the continuation goes to the same upstream URL with the forwarded headers', async () => {
  const h = await start({ env: HEURISTIC, replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))] });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    assert.equal(h.seen[1].url, h.seen[0].url);
    assert.equal(h.seen[1].headers['content-type'], 'application/json');
  } finally {
    h.close();
  }
});

// Like answer(), but the items arrive as output_item.done events and the completed event's
// response carries only `completed` (an output list, or nothing at all).
function streamedAnswer(id, text, items, completed) {
  return [
    ev('response.created', { response: { id } }),
    ev('response.output_text.delta', { delta: text }),
    ...items.map((item) => ev('response.output_item.done', { item })),
    ev('response.completed', { response: { id, ...completed, usage: USAGE } }),
  ];
}

// Runs one turn whose first generation is streamed as `streamedAnswer(...)` with `completed`.
async function turnAfterStreamed(completed) {
  const replies = [sse(streamedAnswer('r1', PROMISE, [messageItem('msg_r1', PROMISE)], completed)), sse(answer('r2', DONE))];
  const h = await start({ env: HEURISTIC, replies });
  try {
    const input = [user('fix the parser'), ...shellStep('k1')];
    await (await post(h, request(input))).text();
    return { input, seen: h.seen };
  } finally {
    h.close();
  }
}

test('a completed event with an empty or missing output is resumed from the streamed items', async () => {
  for (const completed of [{ output: [] }, {}]) {
    const { input, seen } = await turnAfterStreamed(completed);
    assert.equal(seen.length, 2, `resumed when the completed event is ${JSON.stringify(completed)}`);
    assert.deepEqual(seen[1].body.input[input.length], {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PROMISE, annotations: [] }],
    });
  }
});

test('a turn still waiting on a streamed tool call is not resumed, even when the completed output is empty', async () => {
  const call = { type: 'function_call', call_id: 'k2', name: 'shell', arguments: '{"command":["node","--test"]}', status: 'completed' };
  const first = streamedAnswer('r1', PROMISE, [messageItem('msg_r1', PROMISE), call], { output: [] });
  const h = await start({ env: HEURISTIC, replies: [sse(first), sse(answer('r2', DONE))] });
  try {
    const res = await post(h, request([user('fix the parser'), ...shellStep('k1')]));
    assert.equal(await res.text(), first.join(''));
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('two streams of one session that both reach the stop check cannot go over LAYA_MAX_CONTINUES', async () => {
  const verdict = { unfinished: 0.9, reasons: ['test'], cost: null };
  const waiting = [];
  // Both streams reach the stop check before either is answered, so both pass the first cap check.
  const stopCheckFn = () => new Promise((resolve) => {
    waiting.push(() => resolve(verdict));
    if (waiting.length === 2) waiting.splice(0).forEach((release) => release());
    else setTimeout(() => resolve(verdict), 500).unref();
  });
  const h = await start({
    env: { ...LAYA_ON, LAYA_MAX_CONTINUES: '1' },
    deps: { stopCheckFn },
    replies: [sse(answer('r1', PROMISE)), sse(answer('r2', PROMISE)), sse(answer('r3', DONE))],
  });
  try {
    const input = [user('fix the parser'), ...shellStep('k1')];
    const replies = await Promise.all([post(h, request(input)), post(h, request(input))]);
    await Promise.all(replies.map((r) => r.text()));
    await until(() => h.logged.length === 2);
    assert.equal(h.seen.length, 3, 'one continuation request, not two');
    assert.equal(h.stats.continued, 1);
  } finally {
    h.close();
  }
});

test('a failed laya stop check is noted on one line of at most 80 characters', async () => {
  const h = await start({
    env: LAYA_ON,
    deps: { stopCheckFn: async () => { throw new Error(`a\r\nb${'c'.repeat(100)}`); } },
    replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))],
  });
  try {
    await (await post(h, request([user('fix the parser'), ...shellStep('k1')]))).text();
    await until(() => h.logged.length === 1);
    assert.equal(h.logged[0].continues[0].source, `heuristic (laya failed: a b${'c'.repeat(77)})`);
  } finally {
    h.close();
  }
});

test('formatContinue prints the resume line and a dim detail line', () => {
  const line = formatContinue({ n: 2, effort: 'high', step: 3, unfinished: 0.823, source: 'laya', reasons: ['laya unfinished 0.82'] });
  assert.equal(stripAnsi(line), 'Laya  RESUME #2 → HIGH  ✓ APPLIED\n     Step 3 · unfinished 0.82 · laya · laya unfinished 0.82');
  const bare = stripAnsi(formatContinue({ n: 1, effort: 'medium', step: 1, unfinished: 0.75, source: 'heuristic', reasons: [] }));
  assert.equal(bare.split('\n')[1], '     Step 1 · unfinished 0.75 · heuristic');
});

const PLAN_OPEN = [{ step: 'Write parser', status: 'completed' }, { step: 'Add tests', status: 'pending' }];
const PLAN_DONE = [{ step: 'Write parser', status: 'completed' }, { step: 'Add tests', status: 'completed' }];

test('a routed Responses request with open plan steps gets the reminder as its last item', async () => {
  const h = await start({ env: { ...HEURISTIC, LAYA_CONTINUE: 'off' }, replies: [sse(answer('r1', 'Working on it.'))] });
  try {
    const input = [user('refactor the parser'), ...planStep(PLAN_OPEN)];
    await (await post(h, request(input))).text();

    const sent = h.seen[0].body.input;
    assert.deepEqual(sent.slice(0, input.length), input, 'the prefix is untouched for prompt caching');
    assert.equal(sent.length, input.length + 1);
    const reminder = sent.at(-1);
    assert.equal(reminder.type, 'message');
    assert.equal(reminder.role, 'developer');
    assert.match(reminder.content[0].text, /^\[laya\] 1 of 2 plan steps done\. Open steps:\n- Add tests\n/);
    await until(() => h.logged.length === 1);
    assert.equal(h.logged[0].nudged, true);
    assert.equal(h.stats.nudged, 1);
  } finally {
    h.close();
  }
});

test('no reminder when the plan has no open step', async () => {
  const h = await start({ env: { ...HEURISTIC, LAYA_CONTINUE: 'off' }, replies: [sse(answer('r1', DONE))] });
  try {
    const input = [user('refactor the parser'), ...planStep(PLAN_DONE)];
    await (await post(h, request(input))).text();
    assert.deepEqual(h.seen[0].body.input, input);
    await until(() => h.logged.length === 1);
    assert.equal('nudged' in h.logged[0], false);
  } finally {
    h.close();
  }
});

test('LAYA_NUDGE=off appends no reminder', async () => {
  const h = await start({ env: { ...HEURISTIC, LAYA_CONTINUE: 'off', LAYA_NUDGE: 'off' }, replies: [sse(answer('r1', 'Working.'))] });
  try {
    const input = [user('refactor the parser'), ...planStep(PLAN_OPEN)];
    await (await post(h, request(input))).text();
    assert.deepEqual(h.seen[0].body.input, input);
    assert.equal(h.stats.nudged, 0);
  } finally {
    h.close();
  }
});

test('a Chat Completions request with open todos gets the reminder as a final system message', async () => {
  const todos = { todos: [{ content: 'Write parser', status: 'completed' }, { content: 'Add tests', status: 'pending' }] };
  const messages = [
    { role: 'user', content: 'refactor the parser' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'todowrite', arguments: JSON.stringify(todos) } }] },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
  ];
  const json = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Working.' } }], usage: { completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } } });
  const h = await start({ env: { ...HEURISTIC, LAYA_CONTINUE: 'off' }, replies: [{ type: 'application/json', body: json }] });
  try {
    const res = await post(h, { model: 'm', stream: false, reasoning_effort: 'low', messages }, '/v1/chat/completions');
    assert.equal(res.status, 200);
    await res.text();
    const sent = h.seen[0].body.messages;
    assert.deepEqual(sent.slice(0, messages.length), messages);
    assert.deepEqual(sent.at(-1).role, 'system');
    assert.match(sent.at(-1).content, /^\[laya\] 1 of 2 plan steps done\. Open steps:\n- Add tests\n/);
    await until(() => h.logged.length === 1);
    assert.equal(h.logged[0].api, 'chat');
    assert.equal(h.logged[0].nudged, true);
  } finally {
    h.close();
  }
});

test('a request the router leaves alone gets no reminder and is never resumed', async () => {
  const h = await start({ env: HEURISTIC, replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))] });
  try {
    const body = { model: 'gpt-x', input: [user('refactor the parser'), ...planStep(PLAN_OPEN), ...shellStep('k1')], stream: true };
    const res = await post(h, body);
    await res.text();
    assert.deepEqual(h.seen[0].body, body);
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

test('LAYA_MODE=off neither reminds nor resumes', async () => {
  const h = await start({ env: { LAYA_MODE: 'off' }, replies: [sse(answer('r1', PROMISE)), sse(answer('r2', DONE))] });
  try {
    const body = request([user('refactor the parser'), ...planStep(PLAN_OPEN), ...shellStep('k1')]);
    const reply = await (await post(h, body)).text();
    assert.equal(reply, answer('r1', PROMISE).join(''));
    assert.deepEqual(h.seen[0].body, body, 'off leaves the request byte-identical');
    assert.equal(h.seen.length, 1);
  } finally {
    h.close();
  }
});

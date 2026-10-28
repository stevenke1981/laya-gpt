import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';

// Codex closes its connection as soon as it has response.completed, while the upstream
// stream is still open. The generation finished, so it must still be logged with its usage.
const ROUTE = async () => ({ target: 0, hold: 0, release: true, stuck: 0, reasons: ['test'], cost: null });
const USAGE = { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 7 } };
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Upstream that sends a whole generation, then keeps the stream open a while before ending.
function lingeringUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev('response.created', { response: { id: 'r1' } }));
      res.write(ev('response.completed', { response: { id: 'r1', output, usage: USAGE } }));
      setTimeout(() => res.end(), 300);
    });
  });
}

// Posts a streamed Responses request and hangs up as soon as response.completed arrives.
function postAndLeaveAtCompleted(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port, method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
        if (text.includes('response.completed')) {
          req.destroy();
          resolve();
        }
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
    req.end(JSON.stringify(body));
  });
}

async function waitFor(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

for (const continueTurns of ['on', 'off']) {
  test(`a client that leaves at response.completed is still logged (LAYA_CONTINUE=${continueTurns})`, async () => {
    const upstream = lingeringUpstream();
    const upstreamPort = await listen(upstream);
    const config = {
      ...loadConfig({ LAYA_MODE: 'heuristic', LAYA_CONTINUE: continueTurns, OPENROUTER_API_KEY: '' }),
      upstream: `http://127.0.0.1:${upstreamPort}/v1`,
    };
    const records = [];
    const { server, stats } = createProxy(config, {
      decideFn: ROUTE, log: { write: (r) => records.push(r) }, print: () => {},
    });
    const port = await listen(server);
    try {
      await postAndLeaveAtCompleted(port, {
        model: 'gpt-6.1-terra', stream: true, reasoning: { effort: 'medium' },
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      });
      await waitFor(() => records.length > 0);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 200);
      assert.equal(records[0].usage?.output_tokens_details?.reasoning_tokens, 7);
      assert.equal(stats.reasoningTokens[records[0].effort], 7);
    } finally {
      server.close();
      upstream.close();
      server.closeAllConnections?.();
      upstream.closeAllConnections?.();
    }
  });
}

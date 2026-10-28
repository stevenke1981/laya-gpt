import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsModelRouting, modelId, clampEffort } from '../src/model.js';
import { createRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { parseTurn } from '../src/trajectory.js';

const config = loadConfig({ LAYA_MODE: 'heuristic' });
const userMsg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const ok = (i) => [
  { type: 'function_call', name: 'shell', call_id: `k${i}`, arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) },
  { type: 'function_call_output', call_id: `k${i}`, output: 'Exit code: 0\nOutput:\nsrc' },
];
const route = (router, input) => router.route({ input }, 's1', null, parseTurn(input));

test('config: one model, default effort medium, long-task help on', () => {
  assert.equal(config.model, 'gpt-6.1-terra');
  assert.deepEqual(config.ladder, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(config.defaultEffort, 'medium');
  assert.equal(config.port, 8790);
  assert.deepEqual([config.continueTurns, config.maxContinues, config.continueThreshold, config.nudge], [true, 3, 0.6, true]);
  const custom = loadConfig({ LAYA_GPT_MODEL: 'gpt-x', LAYA_DEFAULT_EFFORT: 'HIGH', LAYA_CONTINUE: 'off', LAYA_MAX_CONTINUES: '1', LAYA_NUDGE: 'off' });
  assert.deepEqual([custom.model, custom.defaultEffort, custom.continueTurns, custom.maxContinues, custom.nudge], ['gpt-x', 'high', false, 1, false]);
  assert.throws(() => loadConfig({ LAYA_DEFAULT_EFFORT: 'max' }), /LAYA_DEFAULT_EFFORT must be one of LAYA_LEVELS/);
  assert.throws(() => loadConfig({ LAYA_CONTINUE: 'maybe' }), /LAYA_CONTINUE must be on\|off/);
  assert.throws(() => loadConfig({ LAYA_CONTINUE_THRESHOLD: '2' }), /LAYA_CONTINUE_THRESHOLD must be 0\.\.1/);
});

test('wantsModelRouting: aliases, the model id and its openai/ form', () => {
  for (const model of ['laya-auto', 'AUTO', 'gpt-6.1-terra', 'openai/gpt-6.1-terra']) {
    assert.equal(wantsModelRouting({ model }, config), true, model);
  }
  for (const model of ['gpt-6.1-sol', 'gpt-4o', '', undefined]) assert.equal(wantsModelRouting({ model }, config), false, String(model));
});

test('modelId adds the openai/ prefix only on OpenRouter; clampEffort maps minimal to low', () => {
  assert.equal(modelId(config, false), 'gpt-6.1-terra');
  assert.equal(modelId(config, true), 'openai/gpt-6.1-terra');
  assert.equal(modelId(loadConfig({ LAYA_GPT_MODEL: 'vendor/x' }), true), 'vendor/x');
  assert.equal(clampEffort('minimal'), 'low');
  assert.equal(clampEffort('xhigh'), 'xhigh');
});

test('router: a resumed turn never drops below the default effort, and a new turn resets it', async () => {
  const router = createRouter(config);
  const first = [userMsg('list the files'), ...ok(1)];
  assert.equal((await route(router, first)).effort, 'low');
  assert.equal(router.continuesOf('s1'), 0);

  // The proxy resumed this turn: one rung up, at least the default.
  assert.deepEqual(router.noteContinue('s1'), { continues: 1, effort: 'medium' });
  assert.equal(router.continuesOf('s1'), 1);

  const later = [...first, ...ok(2), ...ok(3)];
  const d = await route(router, later);
  assert.equal(d.effort, 'medium');
  assert.match(d.reasons.join(';'), /resumed turn keeps default effort/);
  assert.equal(router.continuesOf('s1'), 1);

  // A new user turn starts over.
  await route(router, [...later, userMsg('now the tests')]);
  assert.equal(router.continuesOf('s1'), 0);
});

test('router: noteContinue climbs one rung per resume and stops at the top', () => {
  const router = createRouter(config);
  // An unseen session counts as sitting at the default.
  assert.deepEqual(router.noteContinue('x'), { continues: 1, effort: 'high' });
  assert.deepEqual(router.noteContinue('x'), { continues: 2, effort: 'xhigh' });
  assert.deepEqual(router.noteContinue('x'), { continues: 3, effort: 'xhigh' });
});

test('router: Laya scores a new turn against the default effort', async () => {
  const seen = [];
  const decideFn = async (turn, opts) => {
    seen.push(opts.currentEffort);
    return { target: 0, hold: 0, release: true, stuck: 0, reasons: ['laya'], cost: 0 };
  };
  const router = createRouter(loadConfig({ OPENROUTER_API_KEY: 'k' }), { decideFn });
  const input = [userMsg('hello there')];
  assert.equal((await route(router, input)).effort, 'low');
  await route(router, [...input, ...ok(1)]);
  assert.deepEqual(seen, ['medium', 'low']);
});

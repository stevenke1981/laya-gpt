import os from 'node:os';
import path from 'node:path';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function parseLadder(raw) {
  const ladder = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = ladder.filter((e) => !EFFORTS.includes(e));
  if (bad.length || ladder.length === 0) {
    throw new Error(`LAYA_LEVELS must be a comma list of ${EFFORTS.join('/')}; got "${raw}"`);
  }
  return ladder;
}

function intEnv(env, name, fallback) {
  const v = env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer; got "${v}"`);
  return n;
}

function probabilityEnv(env, name, fallback) {
  const v = Number(env[name] ?? fallback);
  if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be 0..1; got "${env[name]}"`);
  return v;
}

function switchEnv(env, name, fallback) {
  const v = (env[name] || fallback).toLowerCase();
  if (!['on', 'off'].includes(v)) throw new Error(`${name} must be on|off; got "${v}"`);
  return v === 'on';
}

export function loadConfig(env = process.env) {
  const home = env.LAYA_HOME || path.join(os.homedir(), '.laya-gpt');
  // The local laya server decides by default. It needs no key, and when it is down every
  // decision falls back to the rules, so the default never blocks a client.
  const mode = (env.LAYA_MODE || 'laya').toLowerCase();
  if (!['laya', 'heuristic', 'llm', 'off'].includes(mode)) throw new Error(`LAYA_MODE must be laya|heuristic|llm|off; got "${mode}"`);
  const ladder = parseLadder(env.LAYA_LEVELS || 'low,medium,high,xhigh');
  const defaultEffort = (env.LAYA_DEFAULT_EFFORT || 'medium').trim().toLowerCase();
  if (!ladder.includes(defaultEffort)) {
    throw new Error(`LAYA_DEFAULT_EFFORT must be one of LAYA_LEVELS (${ladder.join(',')}); got "${defaultEffort}"`);
  }
  const decisionTimeoutMs = intEnv(env, 'LAYA_DECISION_TIMEOUT_MS', 2000);
  // 0 would abort every call and silently turn laya off; LAYA_MODE=heuristic does that openly.
  if (decisionTimeoutMs < 1) throw new Error('LAYA_DECISION_TIMEOUT_MS must be at least 1; use LAYA_MODE=heuristic to turn laya off');
  return Object.freeze({
    host: env.LAYA_HOST || '127.0.0.1',
    port: intEnv(env, 'LAYA_PORT', 8790),
    ladder,
    // Where a turn starts when nothing says it is trivial or hard, and the floor once the
    // model has tried to stop early in a turn.
    defaultEffort,
    // The one upstream model; every routed request is served by it.
    model: env.LAYA_GPT_MODEL || 'gpt-6.1-terra',
    // Client model names that hand the request to the router (besides the model id itself).
    autoModels: (env.LAYA_AUTO_MODELS || 'laya-auto,auto').split(',').map((s) => s.trim()).filter(Boolean),
    // Long-task help: resume a turn the model ended before the work was done, and remind it
    // of an unfinished plan before each generation.
    continueTurns: switchEnv(env, 'LAYA_CONTINUE', 'on'),
    maxContinues: intEnv(env, 'LAYA_MAX_CONTINUES', 5),
    continueThreshold: probabilityEnv(env, 'LAYA_CONTINUE_THRESHOLD', 0.6),
    nudge: switchEnv(env, 'LAYA_NUDGE', 'on'),
    mode,
    // Fixed upstream; when unset the auth type picks ChatGPT backend, OpenRouter or API.
    upstream: env.LAYA_UPSTREAM || '',
    chatgptUpstream: env.LAYA_CHATGPT_UPSTREAM || 'https://chatgpt.com/backend-api/codex',
    apiUpstream: env.LAYA_API_UPSTREAM || 'https://api.openai.com/v1',
    openrouterUpstream: env.LAYA_OPENROUTER_UPSTREAM || 'https://openrouter.ai/api/v1',
    judgeModel: env.LAYA_JUDGE_MODEL || '',
    judgeEffort: env.LAYA_JUDGE_EFFORT || 'low',
    judgeTimeoutMs: intEnv(env, 'LAYA_JUDGE_TIMEOUT_MS', 2500),
    // laya-deploy's Decisions API; its checkpoint (multilingual by default: requests mix languages),
    // and the bearer token when the server sets LAYA_DEPLOY_API_KEY.
    decisionUrl: env.LAYA_DECISION_URL || 'http://127.0.0.1:8100/api/alpha/decisions',
    decisionModel: env.LAYA_DECISION_MODEL || 'multilingual',
    decisionKey: env.LAYA_API_KEY || '',
    decisionTimeoutMs,
    // Start the local laya server (laya-deploy) with the proxy when none answers.
    layaAutostart: switchEnv(env, 'LAYA_AUTOSTART', 'on'),
    // laya is overconfident: below this top probability it abstains and the rules decide.
    minConfidence: probabilityEnv(env, 'LAYA_MIN_CONFIDENCE', 0.5),
    home,
    logFile: path.join(home, 'decisions.jsonl'),
    eventFile: path.join(home, 'events.jsonl'),
    quiet: env.LAYA_QUIET === '1',
  });
}

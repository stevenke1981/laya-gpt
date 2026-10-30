// Local laya (laya-deploy) via its Decisions API: typed questions in, probabilities out,
// about 50 ms on a local GPU and no API key. Questions follow laya decision mode: the state
// holds only the subject being judged (a short phrase), every question is a `choice` whose
// options say what sets them apart, there is no catch-all option, and this code owns the
// thresholds. laya is overconfident and weak at counting, so its answers are gated by the
// rules in policy.js and longtask.js (see combineEffort and layaStopCheck).
import { assessStop } from './longtask.js';

const MAX_REQUEST = 800;
const MAX_CLOSING = 500;
const SYNTHESIS_READS = 4;
const REPEAT_WINDOW = 6;
const STUCK_HOLD_2 = 0.75;
const STUCK_HOLD_1 = 0.5;
const STUCK_RELEASE = 0.25;
const SURE_DONE = 0.9;

// New turn: laya reads the request itself, where rules only see keywords and length.
const REQUEST_CRITERIA = {
  minimal: 'a greeting, thanks or acknowledgement with nothing to do',
  low: 'a greeting, thanks, or a quick factual question',
  medium: 'an ordinary coding task: add a small feature, edit a file, write a script',
  high: 'hard engineering: design, refactor across modules, debug a subtle failure, find a root cause',
  xhigh: 'a very large or risky job: redesign a system architecture, security-critical or concurrency bugs that resist many attempts',
};
// Inside a turn: laya reads one coarse phrase about the last step.
const STEP_CRITERIA = {
  minimal: 'trivial: nothing left to think about',
  low: 'routine progress: it just read, listed or searched files, or a command succeeded',
  medium: 'needs thought: it just edited code, has many findings to combine, or hit one new failure',
  high: 'stuck: two or three failures in a row, or the same failing command again',
  xhigh: 'deeply stuck: four or more failures in a row; the approach must change',
};
const STUCK_QUESTION = {
  type: 'choice',
  instructions: 'Is the coding agent stuck?',
  criteria: {
    stuck: 'it fails again and again or repeats the same failing action',
    progressing: 'its steps succeed, or it is fixing a single new failure',
  },
};
// Two views of the closing text, asked in one call (they share the state). `end` tells a
// request for the user apart; `work` catches progress reports that list what remains.
const STOP_QUESTIONS = {
  end: {
    type: 'choice',
    instructions: 'What does the agent ask or say at the end?',
    criteria: {
      will_continue: 'plans or offers to keep going on the same task',
      done: 'says the task is complete',
      needs_user: 'asks for a key, password, login or a decision only the user can make',
    },
  },
  work: {
    type: 'choice',
    instructions: 'Is the work in this message finished?',
    criteria: {
      in_progress: 'part of the work is done and more remains: next steps, the remaining modules, then run the tests',
      complete: 'everything is done and verified; nothing remains',
    },
  },
};
// Stop rules that settle the question without asking laya.
const HARD_STOP_REASONS = new Set(['no work started', 'needs the user']);

function criteriaFor(table, ladder) {
  return Object.fromEntries(ladder.map((e) => [e, table[e] ?? `${e} reasoning effort`]));
}

function failureStreak(steps) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].failed; i--) n++;
  return n;
}

function repeatsFailure(steps) {
  const failed = steps.slice(-REPEAT_WINDOW).filter((s) => s.failed).map((s) => s.command.replace(/\s+/g, ' ').trim());
  return new Set(failed).size < failed.length;
}

function readsSinceEdit(steps) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].kind !== 'edit'; i--) if (steps[i].kind === 'read') n++;
  return n;
}

const KIND_PHRASE = {
  read: 'read a file', edit: 'edited code', verify: 'ran the tests or build', exec: 'ran a command', tool: 'used a tool',
};

/**
 * One coarse phrase about where the turn stands, so identical situations ask identical
 * questions. Numbers become a few fixed phrases; laya reads words better than counts.
 * @param {Array<{kind:string, command:string, failed:boolean|null}>} steps at least one step
 */
export function situation(steps) {
  const last = steps.at(-1);
  const verb = KIND_PHRASE[last.kind] ?? 'ran a command';
  if (last.failed == null) return `${verb}, still running`;
  if (!last.failed) {
    const reads = readsSinceEdit(steps);
    if (last.kind === 'read' && reads >= SYNTHESIS_READS) return `read ${reads} files since the last edit`;
    return `${verb}, it worked`;
  }
  const streak = failureStreak(steps);
  const parts = [`${verb}, it failed`];
  parts.push(streak === 1 ? 'first failure' : streak >= 4 ? '4 or more failures in a row' : `${streak} failures in a row`);
  if (repeatsFailure(steps)) parts.push('the same failing command was repeated');
  return parts.join('; ');
}

/** The state and questions of an effort call: the request on a new turn, the last step after. */
export function effortCall(turn, ladder) {
  if (turn.steps.length === 0) {
    return {
      state: { request: turn.userText.slice(0, MAX_REQUEST) },
      questions: {
        effort: { type: 'choice', instructions: 'How much reasoning does this request need?', criteria: criteriaFor(REQUEST_CRITERIA, ladder) },
      },
    };
  }
  return {
    state: { last_step: situation(turn.steps) },
    questions: {
      effort: { type: 'choice', instructions: 'How much reasoning does the coding agent need for its next step?', criteria: criteriaFor(STEP_CRITERIA, ladder) },
      stuck: STUCK_QUESTION,
    },
  };
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function choiceOf(answer, options) {
  const p = answer?.probabilities;
  if (!isRecord(answer) || answer.type !== 'choice' || !options.includes(answer.choice) || !isRecord(p)
    || !options.every((key) => Object.hasOwn(p, key) && Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1)) {
    throw new Error('laya returned an unexpected answer shape');
  }
  const prob = (key) => p[key];
  return { choice: answer.choice, top: prob(answer.choice), prob };
}

// Validate the entire requested answer set before any caller can reuse a response.
// Confidence thresholds are caller policy; a well-formed abstention can still be cached.
function validateAnswers(answers, questions) {
  if (!isRecord(answers)) throw new Error('laya returned an unexpected answer shape');
  for (const [key, question] of Object.entries(questions)) {
    if (!Object.hasOwn(answers, key)) throw new Error('laya returned an unexpected answer shape');
    choiceOf(answers[key], Object.keys(question.criteria));
  }
  // toAssessment consumes optional stuck data even on a fresh turn, where only
  // effort was requested. Validate that parser input before retaining it as well.
  if (questions.effort && !questions.stuck && answers.stuck != null) {
    choiceOf(answers.stuck, Object.keys(STUCK_QUESTION.criteria));
  }
}

/**
 * Maps laya answers onto the policy's assessment shape. Abstains (throws) when the top
 * option is below `minConfidence`, so the caller falls back to the rules.
 */
export function toAssessment(answers, ladder, minConfidence) {
  const effort = choiceOf(answers?.effort, ladder);
  if (effort.top < minConfidence) {
    throw new Error(`laya abstained: ${effort.choice} ${effort.top.toFixed(2)} < ${minConfidence}`);
  }
  const target = ladder.indexOf(effort.choice);
  const reasons = [`laya ${effort.choice} ${effort.top.toFixed(2)}`];
  if (answers.stuck == null) return { target, hold: 0, release: false, stuck: null, reasons };
  const stuck = choiceOf(answers.stuck, ['stuck', 'progressing']).prob('stuck');
  return {
    target,
    hold: stuck >= STUCK_HOLD_2 ? 2 : stuck >= STUCK_HOLD_1 ? 1 : 0,
    release: stuck < STUCK_RELEASE,
    stuck,
    reasons: [...reasons, `stuck ${stuck.toFixed(2)}`],
  };
}

/**
 * Gates laya's effort with the rules. A new turn follows laya, which reads the request.
 * Inside a turn laya may only raise the effort: it is weak at counting failures, so the
 * rules' escalation always stands, and a tie keeps the rules' (deterministic) hold.
 */
export function combineEffort(laya, heuristic, newTurn) {
  if (newTurn || laya.target > heuristic.target) return laya;
  return { ...heuristic, reasons: [...heuristic.reasons, ...laya.reasons] };
}

// A laya that times out or cannot be reached is skipped for a while, so a hung server (a
// checkpoint still loading, a stalled GPU) costs one timeout, not one per generation.
const PAUSE_MS = 30_000;
const pausedUntil = new Map();

/** Ends every pause; for tests. */
export function resetLayaPause() {
  pausedUntil.clear();
}

// laya answers in one deterministic forward pass, and situation() turns steps into a few
// fixed phrases (laya-decisions skill: "so judgments repeat and can be cached"), so an
// identical call is answered from memory. Only answers are kept, never errors; identical
// calls in flight share one request. The key holds the URL and checkpoint, and an entry
// expires after CACHE_TTL_MS in case the server was restarted with other weights.
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();
const cacheCounts = { hits: 0, misses: 0 };

/** Hits, misses and entries of the decision cache since the process started. */
export function layaCacheStats() {
  return { ...cacheCounts, entries: cache.size };
}

/** Empties the decision cache and its counters; for tests. */
export function resetLayaCache() {
  cache.clear();
  cacheCounts.hits = 0;
  cacheCounts.misses = 0;
}

/**
 * postDecision behind the cache; `opts.cacheSize` entries at most (0 or unset: no cache).
 * @returns {Promise<{body:object, cached:boolean}>}
 */
async function cachedDecision(opts, state, questions) {
  const size = opts.cacheSize ?? 0;
  if (!(size > 0)) return { body: await postDecision(opts, state, questions), cached: false };
  const key = JSON.stringify([opts.url, opts.model, state, questions]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key);
    cache.set(key, hit);
    cacheCounts.hits++;
    return { body: await hit.body, cached: true };
  }
  cacheCounts.misses++;
  const entry = { at: Date.now(), body: null };
  // Every waiter shares the validated promise, including its eviction on failure. An
  // older request evicted by the LRU must not delete a newer request for the same key.
  entry.body = postDecision(opts, state, questions).catch((err) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  });
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > size) cache.delete(cache.keys().next().value);
  return { body: await entry.body, cached: false };
}

/** POSTs one Decisions request; resolves to the parsed body or throws on HTTP error. */
async function postDecision(opts, state, questions) {
  const until = pausedUntil.get(opts.url) ?? 0;
  if (Date.now() < until) throw new Error(`laya paused for ${Math.ceil((until - Date.now()) / 1000)} s after a timeout`);
  let res;
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, state, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    // Only a timeout pauses: a refused connection fails at once and costs nothing.
    if (err?.name === 'TimeoutError') pausedUntil.set(opts.url, Date.now() + PAUSE_MS);
    throw err;
  }
  pausedUntil.delete(opts.url);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`laya HTTP ${res.status}: ${body?.error?.message ?? 'no error body'}`);
  validateAnswers(body?.answers, questions);
  return body;
}

/**
 * @param {{userText:string, steps:Array<{kind:string, command:string, failed:boolean|null}>}} turn
 * @param {{url:string, apiKey?:string, model:string, timeoutMs:number, ladder:string[], minConfidence:number, cacheSize?:number}} opts
 * @returns {Promise<{target:number, hold:number, release:boolean, stuck:number|null, reasons:string[], cost:null}>}
 */
export async function layaDecide(turn, opts) {
  const { state, questions } = effortCall(turn, opts.ladder);
  const { body, cached } = await cachedDecision(opts, state, questions);
  const assessment = toAssessment(body?.answers, opts.ladder, opts.minConfidence);
  // laya runs locally: there is no per-call price.
  return { ...assessment, ...(cached ? { reasons: [...assessment.reasons, 'cached'] } : {}), cost: null };
}

/** The end of the closing text, where a promise or a question to the user sits. */
export function closingOf(finalText) {
  const text = String(finalText ?? '').trim();
  return text.length > MAX_CLOSING ? text.slice(-MAX_CLOSING) : text;
}

/**
 * Whether a generation that ended the turn stopped before the task was done.
 * The hard rules decide first (no work started, a request for the user's input, an open
 * plan). Otherwise laya reads the closing text, and the rules' own signals (a permission
 * question, a promise of more work) stand unless laya says the agent needs the user.
 * @param {object} turn the parsed turn (userText, steps)
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string} finalText the text of the generation that ended the turn
 * @param {{url:string, apiKey?:string, model:string, timeoutMs:number, cacheSize?:number}} opts
 * @returns {Promise<{unfinished:number, reasons:string[], cost:null}>}
 */
export async function layaStopCheck(turn, plan, finalText, opts) {
  const rules = assessStop(turn, plan, finalText);
  if (HARD_STOP_REASONS.has(rules.reasons[0]) || plan?.open?.length > 0) return { ...rules, cost: null };
  const closing = closingOf(finalText);
  if (!closing) return { ...rules, cost: null };
  const { body, cached } = await cachedDecision(opts, { closing }, STOP_QUESTIONS);
  const end = choiceOf(body?.answers?.end, Object.keys(STOP_QUESTIONS.end.criteria));
  const work = choiceOf(body?.answers?.work, Object.keys(STOP_QUESTIONS.work.criteria));
  const continuing = end.prob('will_continue');
  const inProgress = work.prob('in_progress');
  const reasons = [`laya ${end.choice} ${end.top.toFixed(2)}, in progress ${inProgress.toFixed(2)}${cached ? ' (cached)' : ''}`];
  // A request for the user is a legitimate stop: only laya's own "will continue" counts.
  if (end.choice === 'needs_user') return { unfinished: continuing, reasons, cost: null };
  // A summary that lists finished items reads as "in progress" to `work`; when `end` is
  // sure the message says done, only the rules' own signals can still resume.
  const judged = end.choice === 'done' && end.top >= SURE_DONE ? continuing : Math.max(continuing, inProgress);
  if (rules.unfinished > judged) return { unfinished: rules.unfinished, reasons: [...reasons, ...rules.reasons], cost: null };
  return { unfinished: judged, reasons, cost: null };
}

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

function choiceOf(answer, options) {
  const p = answer?.probabilities;
  if (answer?.type !== 'choice' || !options.includes(answer.choice) || !p || typeof p !== 'object') {
    throw new Error('laya returned an unexpected answer shape');
  }
  const prob = (key) => (Number.isFinite(p[key]) ? p[key] : 0);
  return { choice: answer.choice, top: prob(answer.choice), prob };
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

/** POSTs one Decisions request; resolves to the parsed body or throws on HTTP error. */
async function postDecision(opts, state, questions) {
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
    body: JSON.stringify({ model: opts.model, state, questions }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`laya HTTP ${res.status}: ${body?.error?.message ?? 'no error body'}`);
  return body;
}

/**
 * @param {{userText:string, steps:Array<{kind:string, command:string, failed:boolean|null}>}} turn
 * @param {{url:string, apiKey?:string, model:string, timeoutMs:number, ladder:string[], minConfidence:number}} opts
 * @returns {Promise<{target:number, hold:number, release:boolean, stuck:number|null, reasons:string[], cost:null}>}
 */
export async function layaDecide(turn, opts) {
  const { state, questions } = effortCall(turn, opts.ladder);
  const body = await postDecision(opts, state, questions);
  // laya runs locally: there is no per-call price.
  return { ...toAssessment(body?.answers, opts.ladder, opts.minConfidence), cost: null };
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
 * @param {{url:string, apiKey?:string, model:string, timeoutMs:number}} opts
 * @returns {Promise<{unfinished:number, reasons:string[], cost:null}>}
 */
export async function layaStopCheck(turn, plan, finalText, opts) {
  const rules = assessStop(turn, plan, finalText);
  if (HARD_STOP_REASONS.has(rules.reasons[0]) || plan?.open?.length > 0) return { ...rules, cost: null };
  const closing = closingOf(finalText);
  if (!closing) return { ...rules, cost: null };
  const body = await postDecision(opts, { closing }, STOP_QUESTIONS);
  const end = choiceOf(body?.answers?.end, Object.keys(STOP_QUESTIONS.end.criteria));
  const work = choiceOf(body?.answers?.work, Object.keys(STOP_QUESTIONS.work.criteria));
  const continuing = end.prob('will_continue');
  const inProgress = work.prob('in_progress');
  const reasons = [`laya ${end.choice} ${end.top.toFixed(2)}, in progress ${inProgress.toFixed(2)}`];
  // A request for the user is a legitimate stop: only laya's own "will continue" counts.
  if (end.choice === 'needs_user') return { unfinished: continuing, reasons, cost: null };
  const judged = Math.max(continuing, inProgress);
  if (rules.unfinished > judged) return { unfinished: rules.unfinished, reasons: [...reasons, ...rules.reasons], cost: null };
  return { unfinished: judged, reasons, cost: null };
}

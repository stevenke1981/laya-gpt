// TypeSafe Laya (typesafe/laya-1.14) via the OpenRouter Decisions API:
// typed questions in, probabilities out — no generated text to parse.

const MAX_STEPS = 12;
const MAX_CMD = 200;
const MAX_TASK = 2000;
const MAX_FINAL = 2000;

const EFFORT_CRITERIA = {
  minimal: 'Trivial: a greeting or a purely mechanical next step.',
  low: 'Routine: reading files, listing, running a known command, an obvious follow-up after success.',
  medium: 'Needs thought: synthesizing many findings, planning or writing a non-trivial edit, interpreting a fresh failure.',
  high: 'Stuck or high stakes: repeated failures, the same failing command again, confusing errors, a subtle bug.',
  xhigh: 'Deeply stuck: many failed attempts in a row; the approach must change entirely.',
};

export function buildState(turn, currentEffort) {
  const steps = turn.steps;
  let consecutive = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].failed; i--) consecutive++;
  return {
    task: turn.userText.slice(0, MAX_TASK),
    next_generation: steps.length + 1,
    current_effort: currentEffort ?? null,
    totals: {
      tool_calls: steps.length,
      failures: steps.filter((s) => s.failed).length,
      consecutive_failures: consecutive,
      edits: steps.filter((s) => s.kind === 'edit').length,
    },
    recent_steps: steps.slice(-MAX_STEPS).map((s, i, arr) => ({
      n: steps.length - arr.length + i + 1,
      kind: s.kind,
      status: s.failed == null ? 'running' : s.failed ? 'failed' : 'ok',
      command: s.command.replace(/\s+/g, ' ').slice(0, MAX_CMD),
    })),
  };
}

export function buildQuestions(ladder) {
  return {
    effort: {
      type: 'score',
      instructions: 'How much reasoning should the coding agent spend on its NEXT generation, given the task and its recent steps?',
      criteria: ladder.map((e) => `${e}: ${EFFORT_CRITERIA[e]}`),
    },
    stuck: {
      type: 'noul',
      instructions: 'Is the coding agent stuck right now — failing repeatedly or going in circles?',
      criteria: {
        true: 'Recent steps keep failing or repeat the same unsuccessful action.',
        false: 'The agent is making progress, or its last step succeeded.',
      },
    },
  };
}

/** Maps Laya answers onto the policy's assessment shape. */
export function toAssessment(answers, ladder, minConfidence) {
  const effort = answers?.effort;
  const stuck = answers?.stuck?.noul;
  if (effort?.type !== 'score' || typeof effort.score !== 'number' || typeof stuck !== 'number') {
    throw new Error('Laya returned an unexpected answer shape');
  }
  if ((effort.confidence ?? 1) < minConfidence) {
    throw new Error(`Laya confidence ${effort.confidence.toFixed(2)} < ${minConfidence}`);
  }
  const target = Math.max(0, Math.min(ladder.length - 1, Math.round(effort.score)));
  const hold = stuck >= 0.75 ? 2 : stuck >= 0.5 ? 1 : 0;
  return {
    target,
    hold,
    release: stuck < 0.25,
    stuck,
    reasons: [`laya score ${effort.score.toFixed(2)} (conf ${(effort.confidence ?? 0).toFixed(2)}), stuck ${stuck.toFixed(2)}`],
  };
}

/** POSTs one Decisions request; resolves to the parsed body or throws on HTTP error. */
async function postDecision(opts, state, questions) {
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      state,
      questions,
      ...(opts.sessionId ? { session_id: opts.sessionId.slice(0, 256) } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Laya HTTP ${res.status}: ${body?.error?.message ?? 'no error body'}`);
  return body;
}

/**
 * @param {{url:string, apiKey:string, model:string, timeoutMs:number, ladder:string[],
 *          minConfidence:number, sessionId?:string, currentEffort?:string}} opts
 * @returns {Promise<{target:number, hold:number, release:boolean, stuck:number, reasons:string[], cost:number|null}>}
 */
export async function layaDecide(turn, opts) {
  const body = await postDecision(opts, buildState(turn, opts.currentEffort), buildQuestions(opts.ladder));
  return { ...toAssessment(body?.answers, opts.ladder, opts.minConfidence), cost: body?.usage?.cost ?? null };
}

const UNFINISHED_QUESTION = {
  type: 'noul',
  instructions: "The coding agent just ended its turn. Did it stop before finishing the user's task, although it could keep going without the user's input?",
  criteria: {
    true: 'Work it said it would do is not done, plan steps are open, changes are unverified, or it asks permission to continue routine work.',
    false: 'The task is done and verified, or it needs information, a decision or credentials only the user can give.',
  },
};

/**
 * Asks Laya whether a generation that ended the turn stopped before the task was done.
 * @param {object} turn the parsed turn (userText, steps)
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string} finalText the text of the generation that ended the turn
 * @param {{url:string, apiKey:string, model:string, timeoutMs:number, sessionId?:string}} opts
 * @returns {Promise<{unfinished:number, reasons:string[], cost:number|null}>}
 */
export async function layaStopCheck(turn, plan, finalText, opts) {
  const state = {
    ...buildState(turn, null),
    final_message: String(finalText ?? '').slice(0, MAX_FINAL),
    plan: plan ? { total: plan.total, done: plan.done, open: [...(plan.open ?? [])] } : null,
  };
  const body = await postDecision(opts, state, { unfinished: UNFINISHED_QUESTION });
  const unfinished = body?.answers?.unfinished?.noul;
  if (!Number.isFinite(unfinished)) throw new Error('Laya returned an unexpected answer shape');
  return { unfinished, reasons: [`laya unfinished ${unfinished.toFixed(2)}`], cost: body?.usage?.cost ?? null };
}

// Long-task help. GPT-6.1 Terra tends to end a turn before a long task is done: it
// summarizes, promises "next I will…", or asks whether to continue. These pure functions
// read the agent's plan, tell whether a finished generation ended the turn, judge whether
// that stop was premature, and write the reminder and resume messages.
// Pure: no I/O, and the request bodies and arrays they receive are never mutated.
import { textOf, isSyntheticUserText } from './trajectory.js';

const OPEN_STEP_CHARS = 120;
const LISTED_STEPS = 5;
const DONE_STATUSES = new Set(['completed', 'cancelled']);
// Responses carries Codex's update_plan only; Chat also carries the opencode todo tools.
const RESPONSES_PLAN_TOOLS = new Set(['update_plan']);
const CHAT_PLAN_TOOLS = new Set(['update_plan', 'todowrite', 'TodoWrite']);
// Output items the server finishes on its own. Anything else (client tools such as
// apply_patch_call or shell_call, and types not known yet) waits for the client, so the
// turn is not over. An allowlist fails safe when a new client tool type appears.
const SERVER_FINISHED_TYPES = new Set([
  'message', 'reasoning', 'web_search_call', 'file_search_call', 'image_generation_call', 'code_interpreter_call',
]);

// Only a request for something the user holds. Each pattern addresses the user directly
// (second person or an imperative), so a summary such as "fixed the login page" or
// "I need to refresh the token" does not count as needing the user.
const NEEDS_USER = [
  /\byour (?:api keys?|passwords?|credentials?|tokens?)\b/i,
  // Not after "I need to": then the agent is describing its own work, not asking the user.
  /(?<!\bI need to\b[^.?!\n]*)\b(?:provide|share|send|enter|give me)\b[^.?!\n]{0,40}\b(?:api keys?|passwords?|credentials?|tokens?)\b/i,
  /\bplease (?:provide|confirm|clarify)\b/i,
  /\bwhich (?:one|option) do you\b/i,
  /\b(?:log ?in|sign ?in) first\b|\byou need to (?:log ?in|sign ?in)\b/i,
  /請提供|請確認|(?:你|您)的(?:密碼|金鑰|帳號|token)|需要(?:你|您)|請先登入|哪一個|哪個選項/,
];
// A direct question: the sentence ends in a question mark (ASCII or full-width).
// "If you want me to, let me know" is not a question, so "want me to" alone is not listed.
// "Let me know if you need anything" closes finished work too, so it is not listed either.
const ASK_PERMISSION = [
  /\b(?:would you like me to|shall I|should I continue|do you want me to)\b[^.!?\n]*[?？]/i,
  /要我[^。！？\n]{0,40}嗎|需要我[^。！？\n]{0,40}嗎|是否要|是否繼續/,
];
// First-person statements of work still to do. Bare status words ("remaining steps", TODO,
// 下一步, 接下來) appear in finished work too, so they do not count on their own.
const PROMISE = [
  /\bnext,?\s+I(?:'ll|’ll| will)\b/i,
  /\bI will now\b/i,
  /\b(?:I|we) still need to\b/i,
  /\bI haven['’]t (?:yet\b|[^.!?\n]{0,60}\byet\b|(?:finished|done|completed|verified|tested)\b)/i,
  // Status phrases, the English counterpart of 尚未完成.
  /\bnot yet (?:done|implemented|finished)\b/i,
  /接下來我會|我還需要|我接著|尚未完成|還沒完成/,
];

const NUDGE_FOOTER = 'Keep working through every remaining step and verify the result before you end your turn. '
  + 'Do not stop to summarize or to ask whether to continue unless you truly need something only the user can provide.';
const CONTINUE_FOOTER = 'Continue now: do the remaining work with your tools, then verify. '
  + 'Only stop to ask if you need information only the user has.';

function itemsOf(body) {
  if (Array.isArray(body?.input)) return body.input;
  if (Array.isArray(body?.messages)) return body.messages;
  return [];
}

// Responses user messages carry type 'message'; Chat messages have no type at all.
function isRealUser(item) {
  return item?.role === 'user'
    && (item.type === undefined || item.type === 'message')
    && !isSyntheticUserText(textOf(item.content));
}

/** Raw `arguments` of every plan call in one item (Responses or Chat), in order. */
function planCallsOf(item) {
  if (item?.type === 'function_call') {
    return RESPONSES_PLAN_TOOLS.has(item.name) ? [item.arguments] : [];
  }
  if (item?.role === 'assistant' && Array.isArray(item.tool_calls)) {
    return item.tool_calls
      .filter((tc) => CHAT_PLAN_TOOLS.has(tc?.function?.name))
      .map((tc) => tc.function.arguments);
  }
  return [];
}

function parsePlanArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Codex uses `plan` with `step`; the opencode todo tools use `todos` with `content`.
function entriesOf(args) {
  const list = Array.isArray(args.plan) ? args.plan : Array.isArray(args.todos) ? args.todos : null;
  if (!list) return null;
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ text: textOf(entry.step ?? entry.content).trim(), done: DONE_STATUSES.has(entry.status) }));
}

function summarize(entries) {
  return {
    total: entries.length,
    done: entries.filter((e) => e.done).length,
    open: entries.filter((e) => !e.done).map((e) => e.text.slice(0, OPEN_STEP_CHARS)),
  };
}

/**
 * The agent's latest plan in the current turn (after the latest real user message):
 * Codex `update_plan` ({plan:[{step,status}]}) or opencode-style `todowrite`/`TodoWrite`
 * ({todos:[{content,status}]}), from a Responses `input` or a Chat `messages` array.
 * @param {object} body request body
 * @returns {{total:number, done:number, open:string[]}|null} null when the turn has no plan
 */
export function turnPlan(body) {
  const items = itemsOf(body);
  const start = items.findLastIndex(isRealUser);
  for (let i = items.length - 1; i > start; i--) {
    const calls = planCallsOf(items[i]);
    if (calls.length === 0) continue;
    // Only the last plan call counts; if it is unreadable the plan is unknown, not the earlier one.
    const args = parsePlanArgs(calls.at(-1));
    const entries = args && entriesOf(args);
    return entries ? summarize(entries) : null;
  }
  return null;
}

/**
 * Whether a finished Responses generation ended the turn, and its visible text.
 * @param {object} response the `response` of a `response.completed` event (has `output`)
 * @returns {{ended:boolean, text:string}} ended: every output item is one the server finishes
 *   on its own (an empty output counts as ended)
 */
export function finalOutput(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const ended = output.every((item) => SERVER_FINISHED_TYPES.has(item?.type));
  const text = output
    .filter((item) => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return { ended, text };
}

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function permissionReasons(text) {
  const reasons = [];
  if (matchesAny(ASK_PERMISSION, text)) reasons.push('asks permission to continue');
  if (matchesAny(PROMISE, text)) reasons.push('promises more work');
  return reasons;
}

/**
 * Heuristic: how likely the agent stopped before the task was done although it could go on alone.
 * @param {{userText:string, steps:Array<{kind:string, command:string, failed:boolean|null}>}} turn
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string} finalText the text of the generation that ended the turn
 * @returns {{unfinished:number, reasons:string[]}} unfinished: 0..1
 */
export function assessStop(turn, plan, finalText) {
  const text = String(finalText ?? '');
  const steps = turn?.steps ?? [];
  // Rules run in order; the first match decides.
  if (steps.length === 0 && plan == null) return { unfinished: 0, reasons: ['no work started'] };
  // Asking for the user's input is a legitimate stop, even with open steps.
  if (matchesAny(NEEDS_USER, text)) return { unfinished: 0.1, reasons: ['needs the user'] };
  if (plan?.open?.length > 0) return { unfinished: 0.9, reasons: [`plan ${plan.done}/${plan.total} done`] };
  const reasons = permissionReasons(text);
  if (reasons.length > 0) return { unfinished: 0.75, reasons };
  // Below the default threshold on purpose: a failed last step is a weaker signal.
  if (steps.at(-1)?.failed === true) return { unfinished: 0.5, reasons: ['ended on a failing step'] };
  return { unfinished: 0.1, reasons: ['looks done'] };
}

function openStepLines(open) {
  const lines = open.slice(0, LISTED_STEPS).map((text) => `- ${text.slice(0, OPEN_STEP_CHARS)}`);
  const more = open.length - lines.length;
  if (more > 0) lines.push(`- ...and ${more} more`);
  return lines.join('\n');
}

/** Reminder appended before a generation while the plan has open steps. */
export function nudgeText(plan) {
  const open = plan?.open ?? [];
  const head = `[laya] ${plan?.done ?? 0} of ${plan?.total ?? 0} plan steps done.`;
  const lines = open.length > 0 ? [`${head} Open steps:`, openStepLines(open)] : [head];
  return [...lines, NUDGE_FOOTER].join('\n');
}

/** Instruction that resumes a turn the agent ended too early. */
export function continueText(plan, reasons) {
  const why = reasons?.length ? reasons.join('; ') : 'work remains';
  const lines = [`[laya] You ended your turn but the task is not finished (${why}).`];
  if (plan) {
    lines.push(`Plan: ${plan.done} of ${plan.total} steps done.`);
    if (plan.open.length > 0) lines.push('Open steps:', openStepLines(plan.open));
  }
  lines.push(CONTINUE_FOOTER);
  return lines.join('\n');
}

#!/usr/bin/env node
// Measures laya-gpt's laya questions against a running laya server, the way the proxy asks
// them (gates included). Usage: node scripts/laya-eval.mjs [decisions URL] [checkpoint]
import { layaDecide, layaStopCheck, combineEffort } from '../src/decisions.js';
import { assess } from '../src/policy.js';

const url = process.argv[2] || 'http://127.0.0.1:8100/api/alpha/decisions';
const model = process.argv[3] || 'english';
const LADDER = ['low', 'medium', 'high', 'xhigh'];
const opts = { url, model, timeoutMs: 60000, ladder: LADDER, minConfidence: 0.5 };
const step = (kind, command, failed) => ({ kind, command, failed });
const fails = (n, same = false) => Array.from({ length: n }, (_, i) => step('exec', same ? 'make' : `make t${i}`, true));

const REQUESTS = [
  ['low', 'hi there'], ['low', 'thanks!'], ['low', '你好'],
  ['medium', 'add a --verbose flag to the CLI'], ['medium', '幫我在 CLI 加一個 --verbose 參數'],
  ['medium', 'write a script that renames all .txt files to .md'],
  ['high', 'refactor the auth module across all services and fix the race condition in session refresh'],
  ['high', '重構整個認證架構並找出 session 競態的根因'],
  ['high', 'find the root cause of the intermittent deadlock in the job scheduler'],
];
const STEPS = [
  ['low', [step('read', 'cat a.js', false)]],
  ['low', [step('exec', 'npm install', false)]],
  ['medium', [step('edit', 'apply_patch', false)]],
  ['medium', [step('verify', 'npm test', true)]],
  ['high', [step('read', 'cat a', false), ...fails(2)]],
  ['xhigh', fails(4)],
  ['xhigh', fails(4, true)],
];
const CLOSINGS = [
  [false, 'I fixed the parser and all 42 tests pass.'],
  [false, '已完成全部修改，測試 42 項全數通過。'],
  [false, 'Done with the refactor. If you want, I can also add docs.'],
  [false, 'All 5 plan steps are complete and the build is green.'],
  [false, 'Summary:\n- Rewrote the lexer\n- Added 12 tests (all pass)\n- Updated README\n\nEverything is in place; `npm test` is green.'],
  [false, 'To deploy, please provide your API key for the staging server.'],
  [false, '請提供你的 OpenAI API 金鑰，我才能部署。'],
  [true, 'I have updated config.js. Next, I will update router.js and then run the tests.'],
  [true, 'The first two modules are migrated. Would you like me to continue with the remaining three?'],
  [true, '我已修改 config.js，接下來我會更新 router.js 並跑測試。'],
  [true, '前兩個模組已遷移完成，要我繼續處理剩下三個嗎？'],
  [true, 'Summary of progress so far: parser rewritten. Remaining: lexer, docs, tests.'],
  [true, 'I updated the schema and the migration. The API handlers still use the old field names; I will fix those and rerun the suite.'],
];

async function effortRow(expected, turn) {
  const rules = assess(turn, LADDER, 'medium');
  try {
    const d = await layaDecide(turn, opts);
    const final = LADDER[combineEffort(d, rules, turn.steps.length === 0).target];
    return { expected, got: final, note: d.reasons.join(', ') };
  } catch (err) {
    return { expected, got: LADDER[rules.target], note: `rules (${err.message})` };
  }
}

let right = 0;
let total = 0;
function report(label, expected, got, note) {
  total++;
  if (expected === got) right++;
  console.log(`${expected === got ? 'ok ' : 'BAD'}  ${String(expected).padEnd(6)} ${String(got).padEnd(6)} ${label.slice(0, 60).replace(/\n/g, ' ')}  [${note}]`);
}

console.log(`laya ${url} (${model})\n-- new turn effort`);
for (const [exp, text] of REQUESTS) {
  const r = await effortRow(exp, { userText: text, steps: [] });
  report(text, r.expected, r.got, r.note);
}
console.log('-- in-turn effort');
for (const [exp, steps] of STEPS) {
  const r = await effortRow(exp, { userText: 'fix it', steps });
  report(steps.map((s) => `${s.kind}:${s.failed ? 'fail' : 'ok'}`).join(' '), r.expected, r.got, r.note);
}
console.log('-- stop check (resume when unfinished >= 0.6)');
const worked = { userText: 'do the task', steps: [step('edit', 'apply_patch', false)] };
for (const [exp, text] of CLOSINGS) {
  const s = await layaStopCheck(worked, null, text, opts);
  report(text, exp ? 'resume' : 'stop', s.unfinished >= 0.6 ? 'resume' : 'stop', `${s.unfinished.toFixed(2)} ${s.reasons.join('; ')}`);
}
console.log(`\n${right}/${total} as expected`);

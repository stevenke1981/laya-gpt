import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnPlan, finalOutput, assessStop, nudgeText, continueText } from '../src/longtask.js';

const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const env = user('<environment_context><cwd>/repo</cwd></environment_context>');
const planCall = (plan, call_id = 'p1') => ({ type: 'function_call', name: 'update_plan', call_id, arguments: JSON.stringify({ plan }) });
const chatUser = (content) => ({ role: 'user', content });
const chatPlan = (name, args, id = 'c1') => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('turnPlan counts done steps and cuts open steps to 120 chars', () => {
  const plan = turnPlan({ input: [user('build it'), planCall([
    { step: 'Read the code', status: 'completed' },
    { step: 'x'.repeat(200), status: 'in_progress' },
    { step: 'Write tests', status: 'pending' },
  ])] });
  assert.equal(plan.total, 3);
  assert.equal(plan.done, 1);
  assert.deepEqual(plan.open, ['x'.repeat(120), 'Write tests']);
});

test('the last plan call of the current turn wins', () => {
  const plan = turnPlan({ input: [
    user('task'),
    planCall([{ step: 'a', status: 'pending' }], 'p1'),
    planCall([{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }], 'p2'),
  ] });
  assert.deepEqual(plan, { total: 2, done: 1, open: ['b'] });
});

test('a plan from an earlier turn does not count', () => {
  const old = [user('old task'), planCall([{ step: 'old', status: 'pending' }])];
  assert.equal(turnPlan({ input: [...old, user('new task')] }), null);
});

test('synthetic environment messages do not end the turn', () => {
  const old = [user('old task'), planCall([{ step: 'old', status: 'pending' }])];
  const plan = turnPlan({ input: [...old, user('new task'), env, planCall([{ step: 'new', status: 'pending' }], 'p2')] });
  assert.deepEqual(plan, { total: 1, done: 0, open: ['new'] });
});

test('Responses: arguments may already be an object', () => {
  const call = { type: 'function_call', name: 'update_plan', arguments: { plan: [{ step: 'a', status: 'completed' }] } };
  assert.deepEqual(turnPlan({ input: [user('task'), call] }), { total: 1, done: 1, open: [] });
});

test('bad JSON, a missing plan array, or no plan gives null', () => {
  assert.equal(turnPlan({ input: [user('task')] }), null);
  assert.equal(turnPlan({}), null);
  assert.equal(turnPlan(null), null);
  assert.equal(turnPlan({ input: [user('task'), { type: 'function_call', name: 'update_plan', arguments: '{"plan":' }] }), null);
  assert.equal(turnPlan({ input: [user('task'), { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ steps: [] }) }] }), null);
});

test('an unreadable last plan call hides an earlier readable one', () => {
  const broken = { type: 'function_call', name: 'update_plan', call_id: 'p2', arguments: '{"plan":' };
  assert.equal(turnPlan({ input: [user('task'), planCall([{ step: 'a', status: 'pending' }]), broken] }), null);
});

test('Chat: update_plan and todowrite/TodoWrite plans; cancelled counts as done', () => {
  const todos = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'cancelled' },
    { content: 'c', status: 'pending' },
  ];
  assert.deepEqual(
    turnPlan({ messages: [chatUser('task'), chatPlan('todowrite', { todos })] }),
    { total: 3, done: 2, open: ['c'] });
  assert.deepEqual(
    turnPlan({ messages: [chatUser('task'), chatPlan('TodoWrite', { todos: [{ content: 'z', status: 'in_progress' }] })] }),
    { total: 1, done: 0, open: ['z'] });
  assert.deepEqual(
    turnPlan({ messages: [chatUser('task'), chatPlan('update_plan', { plan: [{ step: 'p', status: 'completed' }] })] }),
    { total: 1, done: 1, open: [] });
});

test('Chat: user content as parts or string, and a non-plan tool call is ignored', () => {
  const parts = [chatUser([{ type: 'text', text: 'task' }]), chatPlan('update_plan', { plan: [{ step: 'a', status: 'pending' }] })];
  assert.deepEqual(turnPlan({ messages: parts }), { total: 1, done: 0, open: ['a'] });
  const shell = [chatUser('task'), chatPlan('shell', { command: 'ls' })];
  assert.equal(turnPlan({ messages: shell }), null);
});

test('Chat: a plan before the latest real user message is ignored; env strings do not count as a user turn', () => {
  const old = [chatUser('old'), chatPlan('todowrite', { todos: [{ content: 'old', status: 'pending' }] })];
  assert.equal(turnPlan({ messages: [...old, chatUser('new')] }), null);
  const withEnv = [...old, chatUser('new'), chatUser('<environment_context>x</environment_context>'),
    chatPlan('todowrite', { todos: [{ content: 'new', status: 'pending' }] }, 'c2')];
  assert.deepEqual(turnPlan({ messages: withEnv }), { total: 1, done: 0, open: ['new'] });
});

test('turnPlan does not mutate the body', () => {
  const body = { input: [user('task'), planCall([{ step: 'a', status: 'pending' }])] };
  const before = structuredClone(body);
  turnPlan(body);
  assert.deepEqual(body, before);
});

test('finalOutput: a plain answer ends the turn; text joins the output_text parts', () => {
  const out = finalOutput({ output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First.' }, { type: 'refusal', refusal: 'no' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second.' }] },
  ] });
  assert.deepEqual(out, { ended: true, text: 'First.\nSecond.' });
});

test('finalOutput: every client-executed item type keeps the turn open', () => {
  const types = ['function_call', 'custom_tool_call', 'local_shell_call', 'computer_call', 'mcp_call', 'mcp_approval_request'];
  for (const type of types) {
    const out = finalOutput({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }, { type }] });
    assert.equal(out.ended, false, type);
  }
});

test('finalOutput: empty or missing output ends the turn with no text', () => {
  assert.deepEqual(finalOutput({ output: [] }), { ended: true, text: '' });
  assert.deepEqual(finalOutput({}), { ended: true, text: '' });
});

test('finalOutput: unknown client tool items keep the turn open (allowlist, not blocklist)', () => {
  const types = ['apply_patch_call', 'shell_call', 'tool_search_call', 'some_future_call'];
  for (const type of types) {
    const out = finalOutput({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }, { type, call_id: 'c' }] });
    assert.equal(out.ended, false, type);
  }
  assert.equal(finalOutput({ output: [{ role: 'assistant', content: [] }] }).ended, false, 'item without a type');
  assert.equal(finalOutput({ output: [null] }).ended, false, 'null item');
});

test('finalOutput: only server-finished item types end the turn, alone or mixed', () => {
  const serverTypes = ['message', 'reasoning', 'web_search_call', 'file_search_call', 'image_generation_call', 'code_interpreter_call'];
  for (const type of serverTypes) {
    assert.equal(finalOutput({ output: [{ type }] }).ended, true, type);
  }
  const mixed = [{ type: 'reasoning', summary: [] }, { type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant', content: [] }];
  assert.equal(finalOutput({ output: mixed }).ended, true);
});

const turn = (steps = []) => ({ userText: 'task', steps });
const ok = { kind: 'edit', command: 'apply_patch', failed: false };
const bad = { kind: 'verify', command: 'npm test', failed: true };
const open = { total: 3, done: 1, open: ['write tests'] };
const doneAll = { total: 2, done: 2, open: [] };

test('assessStop: no steps and no plan is never resumed', () => {
  assert.deepEqual(assessStop(turn(), null, 'Next I will do it.'), { unfinished: 0, reasons: ['no work started'] });
});

test('assessStop: a plan alone counts as started work', () => {
  assert.deepEqual(assessStop(turn(), doneAll, 'All done.'), { unfinished: 0.1, reasons: ['looks done'] });
});

test('assessStop: asking for user input is 0.1 in English and Chinese, even with open steps', () => {
  const cases = [
    'Please provide your API key.',
    'Which one do you prefer?',
    'Which option do you want?',
    'Could you please confirm the target branch?',
    'Please clarify the schema.',
    'You need to log in first.',
    'Log in first, then rerun the build.',
    'Share the password with me.',
    'Give me your credentials.',
    'Enter the token when prompted.',
    'Your API key is missing.',
    '請提供 API 金鑰',
    '請確認目標分支',
    '需要你的密碼',
    '請先登入',
    '哪一個環境要用？',
    '請選擇哪個選項',
  ];
  for (const text of cases) {
    assert.deepEqual(assessStop(turn([ok]), open, text), { unfinished: 0.1, reasons: ['needs the user'] }, text);
  }
});

test('assessStop: the agent describing its own work is not a request to the user', () => {
  const cases = [
    'I need to refresh the token first; remaining steps are open.',
    'I need to provide the API key before the deploy step.',
    'I still need to log in to the staging box myself.',
  ];
  for (const text of cases) {
    assert.deepEqual(assessStop(turn([ok]), open, text), { unfinished: 0.9, reasons: ['plan 1/3 done'] }, text);
  }
});

test('assessStop: "login" or "token" in a summary, without a request to the user, is not needs-user', () => {
  assert.deepEqual(assessStop(turn([ok]), open, 'Refreshed the token and fixed the sign in page.'), { unfinished: 0.9, reasons: ['plan 1/3 done'] });
});

test('assessStop: open plan steps give 0.9 with the plan count as reason', () => {
  assert.deepEqual(assessStop(turn([ok]), open, 'Done with the first part.'), { unfinished: 0.9, reasons: ['plan 1/3 done'] });
});

test('assessStop: asks permission or promises more work is 0.75 in English and Chinese', () => {
  const cases = [
    'Would you like me to continue with the tests?',
    'Shall I run the migration?',
    'Should I continue with the rest?',
    'Do you want me to fix the other files?',
    'Would you like me to continue？',
    '要我繼續修改嗎？',
    '需要我幫你跑測試嗎?',
    '是否要繼續？',
    'Next, I will add the tests.',
    "Next I'll update the docs.",
    'Next I will add tests.',
    'I will now write the README.',
    'I still need to wire the CLI.',
    'We still need to wire the proxy.',
    "I haven't run the tests yet.",
    "I haven't finished the migration.",
    'The migration is not yet finished.',
    '接下來我會加測試',
    '接下來我會補測試',
    '我還需要接上 CLI',
    '我接著跑測試',
    '尚未完成整合',
    '還沒完成遷移',
  ];
  for (const text of cases) {
    assert.equal(assessStop(turn([ok]), null, text).unfinished, 0.75, text);
  }
});

test('assessStop: "if you want me to" and other conditional offers are not direct questions', () => {
  const text = 'All tests pass. If you want me to also update the docs, let me know.';
  assert.deepEqual(assessStop(turn([ok]), null, text), { unfinished: 0.1, reasons: ['looks done'] });
});

test('assessStop: finished work with bare status words scores below 0.6', () => {
  const cases = [
    'All tests pass. If you want me to also update the docs, let me know.',
    'You still need to restart the server.',
    'See the TODO comments in the code.',
    '下一步建議可以加上 CI',
    'Remaining steps for you: deploy.',
    'Three remaining steps are left.',
    '下一步是重構',
    '還需要補測試',
    '待完成：文件',
    '剩下的交給你',
    '接下來的部署交給你',
  ];
  for (const text of cases) {
    const { unfinished } = assessStop(turn([ok]), null, text);
    assert.ok(unfinished < 0.6, `${text} -> ${unfinished}`);
    assert.deepEqual(assessStop(turn([ok]), null, text).reasons, ['looks done'], text);
  }
});

test('assessStop: closing pleasantries and summaries that mention login or tokens do not count', () => {
  for (const text of ['All done. Let me know if you need anything else.', 'Fixed the login page and the token refresh.', '修好登入頁與金鑰輪替']) {
    assert.deepEqual(assessStop(turn([ok]), null, text), { unfinished: 0.1, reasons: ['looks done'] }, text);
  }
});

test('assessStop: lowercase "todo" in ordinary prose is not a promise', () => {
  assert.deepEqual(assessStop(turn([ok]), null, 'Added a todo list helper.'), { unfinished: 0.1, reasons: ['looks done'] });
});

test('assessStop: permission and promise reasons are both reported', () => {
  assert.deepEqual(
    assessStop(turn([ok]), null, 'Would you like me to continue? Next I will add tests.').reasons,
    ['asks permission to continue', 'promises more work']);
});

test('assessStop: a failing last step is 0.5; a passing or running last step is not', () => {
  assert.deepEqual(assessStop(turn([ok, bad]), null, 'The fix is in.'), { unfinished: 0.5, reasons: ['ended on a failing step'] });
  assert.deepEqual(assessStop(turn([bad, ok]), null, 'The fix is in.'), { unfinished: 0.1, reasons: ['looks done'] });
  assert.equal(assessStop(turn([{ ...ok, failed: null }]), null, 'Done.').unfinished, 0.1);
});

test('assessStop: a plan with no steps falls through to the text rules', () => {
  assert.equal(assessStop(turn(), doneAll, 'Done.').unfinished, 0.1);
  assert.equal(assessStop(turn(), doneAll, 'Would you like me to continue?').unfinished, 0.75);
});

test('assessStop: rules apply in order (user input, open plan, permission, failure)', () => {
  assert.equal(assessStop(turn([bad]), open, 'Please provide the token.').unfinished, 0.1);
  assert.equal(assessStop(turn([bad]), open, 'Would you like me to continue?').unfinished, 0.9);
  assert.equal(assessStop(turn([bad]), null, 'Would you like me to continue?').unfinished, 0.75);
  assert.equal(assessStop(turn([bad]), doneAll, 'Would you like me to continue?').unfinished, 0.75);
  assert.equal(assessStop(turn([bad]), null, 'Fixed.').unfinished, 0.5);
});

test('nudgeText: [laya] line with the counts, open steps and the keep-going rule', () => {
  const text = nudgeText({ total: 4, done: 2, open: ['Write tests', 'Update docs'] });
  assert.match(text, /^\[laya\] 2 of 4 plan steps done\. Open steps:\n- Write tests\n- Update docs\n/);
  assert.match(text, /Keep working through every remaining step/);
  assert.match(text, /verify the result before you end your turn/);
  assert.match(text, /Do not stop to summarize or to ask whether to continue/);
});

test('nudgeText: lists at most five open steps and counts the rest', () => {
  const text = nudgeText({ total: 9, done: 2, open: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] });
  assert.match(text, /- s5\n/);
  assert.ok(!text.includes('- s6'));
  assert.match(text, /- \.\.\.and 2 more\n/);
});

test('nudgeText: stays under 900 chars even with long steps and large counts', () => {
  const open = Array.from({ length: 50 }, () => 'y'.repeat(500));
  const text = nudgeText({ total: 99999999, done: 99999999, open });
  assert.ok(text.length < 900, `length ${text.length}`);
  assert.ok(!text.includes('y'.repeat(121)));
});

test('continueText: [laya] reason line, plan progress, open steps and the resume instruction', () => {
  const text = continueText({ total: 3, done: 1, open: ['Write tests'] }, ['asks permission to continue', 'plan 1/3 done']);
  assert.match(text, /^\[laya\] You ended your turn but the task is not finished \(asks permission to continue; plan 1\/3 done\)\.\n/);
  assert.match(text, /Plan: 1 of 3 steps done\./);
  assert.match(text, /Open steps:\n- Write tests\n/);
  assert.match(text, /Continue now: do the remaining work with your tools, then verify\. Only stop to ask if you need information only the user has\./);
});

test('continueText: without a plan there is no plan or step list', () => {
  const text = continueText(null, ['promises more work']);
  assert.match(text, /\(promises more work\)\./);
  assert.ok(!text.includes('Plan:'));
  assert.ok(!text.includes('Open steps'));
  assert.match(text, /Continue now:/);
});

test('continueText: caps the listed open steps at five', () => {
  const text = continueText({ total: 8, done: 0, open: ['1', '2', '3', '4', '5', '6'] }, ['plan 0/8 done']);
  assert.match(text, /- 5\n- \.\.\.and 1 more\n/);
});

test('assessStop: a work verb promised in the first person counts, an offer does not', () => {
  const edited = turn([{ kind: 'edit', command: 'apply_patch', failed: false }]);
  for (const text of [
    'The API handlers still use the old names; I will fix those and rerun the suite.',
    "Schema updated. I'll update the handlers next.",
    '我已更新 schema，我會再修 API handler 並重跑測試。',
  ]) {
    assert.deepEqual(assessStop(edited, null, text), { unfinished: 0.75, reasons: ['promises more work'] }, text);
  }
  for (const text of [
    "Done. If you want, I'll add docs.",
    'Done with the refactor. If you like, I will update the README too.',
    'I will be happy to help further.',
    '完成了。如果你需要，我會補上文件。',
    // The condition after the promise is an offer too.
    "Tests pass. I'll add docs if you want.",
    "All done! I'll run the suite again later if anything changes.",
    "I'll write the summary below",
    '測試全過。你想要的話我會改文件。',
    '完成。我會補上文件，如果你需要的話。',
  ]) {
    assert.deepEqual(assessStop(edited, null, text), { unfinished: 0.1, reasons: ['looks done'] }, text);
  }
});

test('assessStop: a long run of text with no sentence end stays fast', () => {
  const edited = turn([{ kind: 'edit', command: 'apply_patch', failed: false }]);
  const start = performance.now();
  assessStop(edited, null, '如果你需要' + '我會 '.repeat(100_000));
  assessStop(edited, null, 'if you want ' + 'I will fix '.repeat(40_000));
  assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`);
});

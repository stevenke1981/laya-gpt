// Resumes a Responses turn inside one client response. The terminal `response.completed`
// event is held back; when the caller decides the turn ended too early, a continuation
// request is sent and its events stream on in place of that event, so the client (Codex)
// sees one turn that keeps working. The client gets exactly one terminal event, and the
// continuation's events are renumbered so the stream reads as one response.

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'content-encoding', 'accept-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer']);
// A blank line ends an SSE block; CRLF and LF may be mixed at the boundary.
const BLOCK_END = /\r?\n\r?\n/g;
// A continuation repeats these; the client already got them from the first generation.
const REPEATED_EVENTS = new Set(['response.created', 'response.in_progress']);
// Events that end a response; the client must see exactly one of them.
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete']);

/** Headers that may be passed on: hop-by-hop ones and the ones fetch/Node rewrite are dropped. */
export function forwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v != null) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function drainOrClose(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** Writes one chunk and waits for drain when the client is slow; a closed client is a no-op. */
export async function writeChunk(res, chunk) {
  if (res.destroyed) return;
  if (!res.write(chunk) && !res.destroyed) await drainOrClose(res);
}

/** Writes the status and headers of an upstream fetch Response, Set-Cookie included. */
export function writeUpstreamHead(res, upstream) {
  const headers = forwardHeaders(Object.fromEntries(upstream.headers));
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(upstream.status, headers);
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Reads one SSE block: `event:` names it, `data:` lines join with newlines, comments are skipped.
function toEvent(raw) {
  let eventName = null;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  const data = dataLines.length ? parseObject(dataLines.join('\n')) : null;
  const type = eventName || (typeof data?.type === 'string' ? data.type : null);
  return { raw, type, data };
}

/**
 * Splits an SSE stream into whole events (blocks ending in a blank line).
 * @returns {{push(chunk:Buffer|string):Array<{raw:string, type:string|null, data:object|null}>,
 *            flush():Array<{raw:string, type:string|null, data:object|null}>}}
 *   raw: the event text including its trailing blank line, written to the client as is;
 *   type: the `event:` field or data.type; data: the parsed `data:` JSON or null
 */
export function createSseFramer() {
  const decoder = new TextDecoder();
  let pending = '';

  // Cuts every complete block off the front of `pending`; the rest waits for more bytes.
  function takeBlocks() {
    const events = [];
    let start = 0;
    BLOCK_END.lastIndex = 0;
    for (let m = BLOCK_END.exec(pending); m; m = BLOCK_END.exec(pending)) {
      const end = BLOCK_END.lastIndex;
      events.push(toEvent(pending.slice(start, end)));
      start = end;
    }
    pending = pending.slice(start);
    return events;
  }

  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      return takeBlocks();
    },
    flush() {
      pending += decoder.decode();
      const tail = pending;
      pending = '';
      return tail ? [toEvent(tail)] : [];
    },
  };
}

function replayReasoning(item) {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  if (!item.encrypted_content && summary.length === 0) return [];
  const out = { type: 'reasoning', summary };
  if (item.encrypted_content) out.encrypted_content = item.encrypted_content;
  if (item.content != null) out.content = item.content;
  return [out];
}

// A message keeps its phase (commentary or final) when it has one.
function replayMessage(item) {
  const out = { type: 'message', role: item.role, content: item.content };
  if (item.phase != null) out.phase = item.phase;
  return [out];
}

/**
 * Output items of a finished generation as input items for the next request:
 * ids and statuses dropped (Codex sends none; with store=false ids are not resolvable).
 * @param {object[]} output `response.output`
 * @returns {object[]}
 */
export function replayItems(output) {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if (item.type === 'reasoning') return replayReasoning(item);
    if (item.type === 'message') return replayMessage(item);
    const { id: _id, status: _status, ...rest } = item;
    return [rest];
  });
}

/** A Responses developer message carrying `text` (the nudge and the resume instruction). */
export function developerMessage(text) {
  return { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] };
}

// A string `input` is one user message; anything else that is not an array is no history.
function inputItems(input) {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  return Array.isArray(input) ? input : [];
}

/**
 * The request that resumes the turn: the sent body plus the replayed output, a developer
 * message with `text`, and the given effort when the sent body had a reasoning object.
 * Never mutates `sentBody`.
 * @param {object} sentBody the request body as it went upstream
 * @param {object[]} output `response.output` of the generation that ended the turn
 * @param {string} text the resume instruction (longtask continueText)
 * @param {string} effort the reasoning effort for the resumed generation
 * @returns {object}
 */
export function continuationBody(sentBody, output, text, effort) {
  const body = {
    ...sentBody,
    input: [...inputItems(sentBody.input), ...replayItems(output), developerMessage(text)],
  };
  if (typeof sentBody.reasoning === 'object' && sentBody.reasoning !== null) {
    body.reasoning = { ...sentBody.reasoning, effort };
  }
  return body;
}

/** Whether a fetch Response is an SSE answer. */
export function isEventStream(response) {
  return /text\/event-stream/i.test(response.headers.get('content-type') ?? '');
}

// The continuation's answer when it is a usable event stream; otherwise its body is dropped.
async function usableContinuation(response) {
  if (response.ok && response.body && isEventStream(response)) return response;
  await response.body?.cancel().catch(() => {});
  return null;
}

// Asks the caller for a continuation of a held completed event. A throwing caller releases it.
async function askContinuation(data, round, { onCompleted, onError }) {
  let response;
  try {
    response = await onCompleted(data, round);
  } catch (err) {
    onError?.(err);
    return null;
  }
  return response ? usableContinuation(response) : null;
}

// The output of a generation: its completed list, or else the items streamed with
// response.output_item.done when that list is missing or empty.
function pickOutput(listed, streamed) {
  return Array.isArray(listed) && listed.length > 0 ? listed : streamed;
}

// Both lists exist and disagree in count: the turn cannot be replayed faithfully.
function disagrees(listed, streamed) {
  return Array.isArray(listed) && listed.length > 0 && streamed.length > 0 && listed.length !== streamed.length;
}

// What the client has been sent across the rounds of one response. `output` is the output of
// the generations already replaced by a continuation; `held` is the last replaced completed event.
function newChain() {
  return { firstId: null, seq: -1, output: [], held: null };
}

// A continuation renumbers what the client sees: sequence_number goes on from the last event
// forwarded, and output_index goes on after the items of the generations before it.
function renumber(data, chain) {
  const out = { ...data };
  if (typeof data.sequence_number === 'number') out.sequence_number = (chain.seq += 1);
  if (typeof data.output_index === 'number') out.output_index = data.output_index + chain.output.length;
  return out;
}

// The terminal event of the whole response: the first response id and the output of every generation.
function wholeResponse(data, chain, roundOutput) {
  return {
    ...data,
    response: { ...data.response, id: chain.firstId ?? data.response?.id, output: [...chain.output, ...roundOutput] },
  };
}

// Rebuilds one SSE block around a new data object; the event: line and the block end stay as they were.
function rebuildBlock(raw, data) {
  const ending = raw.match(/(\r?\n)*$/)[0];
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const kept = [];
  let placed = false;
  for (const line of raw.slice(0, raw.length - ending.length).split(/\r?\n/)) {
    if (!line.startsWith('data:')) kept.push(line);
    else if (!placed) {
      kept.push(`data: ${JSON.stringify(data)}`);
      placed = true;
    }
  }
  return kept.join(eol) + ending;
}

function eventBlock(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// The text sent for one upstream event. Round 0 goes out byte for byte; later rounds are renumbered,
// and their terminal event carries the whole response.
function outgoing(event, round, chain, streamed) {
  if (!event.data) return event.raw;
  if (round === 0) {
    if (typeof event.data.sequence_number === 'number') chain.seq = event.data.sequence_number;
    return event.raw;
  }
  const data = renumber(event.data, chain);
  if (!TERMINAL_EVENTS.has(event.type)) return rebuildBlock(event.raw, data);
  return rebuildBlock(event.raw, wholeResponse(data, chain, pickOutput(event.data.response?.output, streamed)));
}

// Sends a completed event that is not replaced; it is the response's terminal event.
async function release(res, event, round, chain, state) {
  state.terminal = true;
  await writeChunk(res, outgoing(event, round, chain, state.items));
  return null;
}

// Handles one parsed event. Returns the continuation Response when the held event was replaced.
async function deliver(res, event, round, hooks, state, chain) {
  const { data } = event;
  if (data) hooks.onEvent?.(data, round);
  if (round > 0 && REPEATED_EVENTS.has(event.type)) return null;
  if (round === 0 && chain.firstId == null && typeof data?.response?.id === 'string') chain.firstId = data.response.id;
  if (event.type === 'response.output_item.done' && data?.item && typeof data.item === 'object') {
    state.items = [...state.items, data.item];
  }
  const holdable = event.type === 'response.completed' && data && !state.decided;
  if (!holdable) {
    if (TERMINAL_EVENTS.has(event.type)) state.terminal = true;
    await writeChunk(res, outgoing(event, round, chain, state.items));
    return null;
  }
  state.decided = true;
  const listed = data.response?.output;
  if (disagrees(listed, state.items)) return release(res, event, round, chain, state);
  const output = pickOutput(listed, state.items);
  const resolved = { ...data, response: { ...data.response, output } };
  const next = await askContinuation(resolved, round, hooks);
  if (res.destroyed) {
    await next?.body?.cancel().catch(() => {});
    return null;
  }
  if (next) {
    chain.output = [...chain.output, ...output];
    chain.held = resolved;
    return next;
  }
  return release(res, event, round, chain, state);
}

// A continuation that breaks off, or ends without a terminal event, still leaves the client one:
// the replaced completed event, with the output so far (earlier generations and this round's items).
async function closeBrokenRound(res, chain, state) {
  if (state.terminal || !chain.held || res.destroyed) return;
  await writeChunk(res, eventBlock('response.completed', wholeResponse(renumber(chain.held, chain), chain, state.items)));
}

// Streams one SSE response. Returns the continuation Response when a held event was replaced.
async function streamRound(res, response, round, hooks, chain) {
  if (!response.body) return null;
  const framer = createSseFramer();
  const state = { decided: false, terminal: false, items: [] };
  const handle = async (events) => {
    for (const event of events) {
      if (res.destroyed) return null;
      const next = await deliver(res, event, round, hooks, state, chain);
      if (next) return next;
    }
    return null;
  };
  try {
    // Returning from inside for-await cancels the body of this round.
    for await (const chunk of response.body) {
      const next = await handle(framer.push(chunk));
      if (next || res.destroyed) return next;
    }
    const next = await handle(framer.flush());
    if (next) return next;
  } catch (err) {
    // The first generation's errors propagate as before; a continuation's are reported and closed out.
    if (round === 0) throw err;
    hooks.onError?.(err);
  }
  if (round > 0) await closeBrokenRound(res, chain, state);
  return null;
}

/**
 * Streams `upstream` (a fetch Response with an SSE body) to `res`, holding each
 * `response.completed`. `onCompleted(data, round)` gets the completed event's data with
 * `response.output` filled in (from the streamed output items when the completed list is
 * missing or empty). It returns null to release the event, or a Promise of a fetch Response
 * whose events continue the stream (its `response.created` and `response.in_progress` are
 * dropped). A failed continuation releases the held event. When the completed list and the
 * streamed items disagree in count, the event is released without asking.
 * @param {import('node:http').ServerResponse} res
 * @param {Response} upstream
 * @param {{onEvent?:(data:object, round:number)=>void, onCompleted:(data:object, round:number)=>Promise<Response|null>|Response|null, onError?:(err:Error)=>void}} hooks
 */
export async function pipeWithContinuation(res, upstream, hooks) {
  writeUpstreamHead(res, upstream);
  const chain = newChain();
  let current = upstream;
  for (let round = 0; current; round++) {
    current = await streamRound(res, current, round, hooks, chain);
  }
  if (!res.destroyed) res.end();
}

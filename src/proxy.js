// Transparent Responses / Chat Completions proxy that rewrites only the reasoning
// effort, so the prompt prefix (and therefore prompt caching) is untouched.
// A routed `laya-auto` request also gets its model rewritten to the one configured model.
// Long-task help: a routed request whose plan has open steps gets a reminder at its end,
// and a Responses turn the model ended early is resumed on the same stream (splice.js).
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { createRouter } from './router.js';
import { parseTurn } from './trajectory.js';
import { parseChatTurn, chatWantsReasoning, applyChatEffort, chatSessionKey } from './chat.js';
import { createDecisionLog, formatDecision, formatContinue, usageTokens } from './log.js';
import { wantsModelRouting, modelId, clampEffort } from './model.js';
import { turnPlan, finalOutput, assessStop, nudgeText, continueText } from './longtask.js';
import { layaStopCheck, layaCacheStats } from './decisions.js';
import {
  continuationBody, developerMessage, forwardHeaders, isEventStream, pipeWithContinuation, writeChunk, writeUpstreamHead,
} from './splice.js';
import { VERSION, BUILD, APP } from './version.js';

const DECODERS = {
  zstd: (b) => zlib.zstdDecompressSync(b),
  gzip: (b) => zlib.gunzipSync(b),
  br: (b) => zlib.brotliDecompressSync(b),
  deflate: (b) => zlib.inflateSync(b),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(buf, encoding) {
  if (!encoding || encoding === 'identity') return buf;
  const fn = DECODERS[encoding.toLowerCase()];
  if (!fn) throw new Error(`unsupported content-encoding: ${encoding}`);
  return fn(buf);
}

export function isChatGptAuth(headers) {
  if (headers['chatgpt-account-id']) return true;
  const auth = String(headers.authorization ?? '');
  return /^Bearer\s+eyJ/.test(auth);
}

export function upstreamBase(config, headers) {
  if (config.upstream) return config.upstream.replace(/\/$/, '');
  if (isChatGptAuth(headers)) return config.chatgptUpstream;
  if (/^Bearer\s+sk-or-/.test(String(headers.authorization ?? ''))) return config.openrouterUpstream;
  return config.apiUpstream;
}

// "/v1/responses?x" -> "<base>/responses?x"; refuses anything that would leave the base origin.
export function upstreamUrl(base, reqUrl) {
  if (!reqUrl.startsWith('/') || reqUrl.startsWith('//')) throw new BadRequest(`invalid request path: ${reqUrl}`);
  const url = base + reqUrl.replace(/^\/v1(?=\/|$)/, '');
  if (new URL(url).origin !== new URL(base).origin) throw new BadRequest(`invalid request path: ${reqUrl}`);
  return url;
}

class BadRequest extends Error {}

function sessionKeyOf(body, headers) {
  return String(body.prompt_cache_key ?? headers.session_id ?? headers.conversation_id ?? 'default');
}

const MAX_JSON_SNIFF = 4 * 1024 * 1024;
// Data lines that can carry the final usage or a reasoning item; other lines are not parsed.
const SNIFF_MARKERS = ['"usage"', 'output_item.done'];

// Per-protocol hooks: how to read the trajectory, whether the request is a
// reasoning request, how to rewrite its effort, and where a plan reminder goes.
const PROTOCOLS = {
  responses: {
    parse: (body) => parseTurn(body.input),
    wantsReasoning: (body) => body.reasoning != null && typeof body.reasoning === 'object',
    apply: (body, effort) => ({ ...body, reasoning: { ...body.reasoning, effort } }),
    remind: (body, text) => ({ ...body, input: [...(Array.isArray(body.input) ? body.input : []), developerMessage(text)] }),
    session: sessionKeyOf,
    judge: true,
  },
  chat: {
    parse: (body) => parseChatTurn(body.messages),
    wantsReasoning: chatWantsReasoning,
    apply: applyChatEffort,
    remind: (body, text) => ({ ...body, messages: [...(Array.isArray(body.messages) ? body.messages : []), { role: 'system', content: text }] }),
    session: chatSessionKey,
    // The LLM judge speaks the Responses API, which chat-only upstreams lack.
    judge: false,
  },
};

export function isOpenRouter(base) {
  return /(^|\.)openrouter\.ai$/i.test(new URL(base).hostname);
}

export function isOpenAiApi(base) {
  return new URL(base).hostname.toLowerCase() === 'api.openai.com';
}

// The OpenAI API routes requests that share a prompt_cache_key to the same cache, which
// raises prompt-cache hits for clients that send none (Chat clients, plain Responses calls).
// Only a real session key is used: "default" would pile every client onto one key. It is
// hashed, so a long or personal `user` value stays short and is not sent as the key. Other
// upstreams may reject unknown fields, so they get the body unchanged.
export function withPromptCacheKey(body, session, base) {
  if (body.prompt_cache_key != null || session === 'default' || !isOpenAiApi(base)) return body;
  return { ...body, prompt_cache_key: `laya:${createHash('sha1').update(session).digest('hex').slice(0, 24)}` };
}

// Watches the response without buffering an SSE stream. It keeps the final usage
// (Responses `response.completed`, a chat chunk's `usage`, or a plain JSON body) and
// hands every parsed event to onEvent, so each data line is parsed once.
function usageSniffer(contentType, onEvent = () => {}) {
  const decoder = new TextDecoder();
  const isJson = /application\/json/i.test(contentType ?? '');
  let pending = '';
  let usage = null;

  function consumeLine(line) {
    if (!line.startsWith('data:') || !SNIFF_MARKERS.some((m) => line.includes(m))) return;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      return; // Partial or non-JSON data line; ignore.
    }
    if (!event || typeof event !== 'object') return;
    usage = event.response?.usage ?? event.usage ?? usage;
    onEvent(event);
  }

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      if (isJson) {
        if (pending.length > MAX_JSON_SNIFF) pending = '';
        return;
      }
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) consumeLine(line);
    },
    finish() {
      const rest = pending;
      pending = '';
      if (!isJson) {
        consumeLine(rest);
        return;
      }
      if (!rest) return;
      try {
        const body = JSON.parse(rest);
        usage = body.usage ?? body.response?.usage ?? usage;
        onEvent(body);
      } catch {
        // Truncated or non-JSON body; no usage.
      }
    },
    get usage() {
      return usage;
    },
  };
}

async function pipeUpstream(res, upstream, onChunk) {
  writeUpstreamHead(res, upstream);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) {
    onChunk?.(chunk);
    // writeChunk waits for drain, so a slow client does not make us buffer the whole stream.
    await writeChunk(res, chunk);
    if (res.destroyed) return;
  }
  res.end();
}

function abortOnClose(res) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  return controller.signal;
}

// LAYA_MODE=off leaves the effort alone, but a laya-auto alias still needs the real model id.
const OFF_DECISION = Object.freeze({ effort: null, from: null, step: 0, hold: 0, reasons: ['mode off'], source: 'off', cost: null, ms: 0 });

// The decision as it went upstream: the effort only when it was applied, the model as sent.
function describeSent(decision, { applyEffort, model, requested }) {
  return {
    ...decision,
    model,
    requested,
    effort: applyEffort ? clampEffort(decision.effort) : null,
    from: applyEffort ? decision.from : null,
  };
}

// The copy of a request that carries the plan reminder at its end, or null when the plan
// has no open step (a finished or missing plan gets no reminder).
function withPlanReminder(protocol, body) {
  const plan = turnPlan(body);
  if (!plan || plan.open.length === 0) return null;
  return protocol.remind(body, nudgeText(plan));
}

// The error text for a stop-check fallback: one line, at most MAX_FAILURE_NOTE characters.
const MAX_FAILURE_NOTE = 80;
function failureNote(err) {
  return String(err?.message ?? err).replace(/[\r\n]+/g, ' ').slice(0, MAX_FAILURE_NOTE);
}

export function createProxy(config, deps = {}) {
  const router = createRouter(config, deps);
  const log = deps.log ?? createDecisionLog(config);
  const print = deps.print ?? ((s) => process.stdout.write(`${s}\n`));
  const openRouterOf = deps.isOpenRouter ?? isOpenRouter;
  const stopCheckFn = deps.stopCheckFn ?? layaStopCheck;
  const stats = {
    requests: 0, routed: 0, byEffort: {}, reasoningTokens: {}, continued: 0, nudged: 0,
    // Upstream prompt cache: input tokens of routed requests and how many of them were cached.
    inputTokens: 0, cachedTokens: 0,
  };
  const identity = { app: APP, version: VERSION, build: BUILD, pid: process.pid, startedAt: new Date().toISOString(), eventStream: true };

  // Effort for this generation, or null when the request is left alone.
  async function decide(body, turn, { session, judgeTarget, applyEffort, routeModel }) {
    if (config.mode === 'off') return routeModel ? OFF_DECISION : null;
    if (!applyEffort && !routeModel) return null;
    return router.route(body, session, judgeTarget, turn);
  }

  // Applies the decision to a copy of the request: the effort when it is applied, and the
  // configured model id when the client handed the model choice to us.
  function rewriteRequest(protocol, body, decision, { applyEffort, inject, openRouter, routeModel }) {
    const withEffort = applyEffort ? protocol.apply(body, clampEffort(decision.effort), inject) : body;
    return routeModel ? { ...withEffort, model: modelId(config, openRouter) } : withEffort;
  }

  function countSent(sent) {
    stats.routed++;
    if (sent.effort) stats.byEffort[sent.effort] = (stats.byEffort[sent.effort] ?? 0) + 1;
  }

  // How unfinished a generation that ended the turn looks. laya judges it in laya mode, gated
  // by the stop rules; when laya fails, the rules decide alone, and `source` says which did.
  async function stopCheck(turn, plan, text, session) {
    if (config.mode !== 'laya') return { ...assessStop(turn, plan, text), source: 'heuristic' };
    try {
      const judged = await stopCheckFn(turn, plan, text, {
        url: config.decisionUrl,
        apiKey: config.decisionKey,
        model: config.decisionModel,
        timeoutMs: config.decisionTimeoutMs,
        cacheSize: config.decisionCacheSize,
      });
      return { ...judged, source: 'laya' };
    } catch (err) {
      return { ...assessStop(turn, plan, text), source: `heuristic (laya failed: ${failureNote(err)})` };
    }
  }

  // Resumes a turn the model ended before the work was done. Returns the continuation
  // Response whose events replace the held completed event, or null to release that event.
  async function resumeTurn(trail, data) {
    const response = data?.response;
    if (!response) return null;
    const { ended, text } = finalOutput(response);
    if (!ended) return null;
    const plan = turnPlan(trail.body);
    const turn = parseTurn(trail.body.input);
    if (turn.steps.length === 0 && plan == null) return null;
    if (router.continuesOf(trail.session) >= config.maxContinues) return null;
    const stop = await stopCheck(turn, plan, text, trail.session);
    if (stop.unfinished < config.continueThreshold) return null;
    // Another stream of this session may have taken the last slot while the stop check ran.
    if (router.continuesOf(trail.session) >= config.maxContinues) return null;

    const { continues, effort } = router.noteContinue(trail.session);
    const body = continuationBody(trail.body, response.output, continueText(plan, stop.reasons), clampEffort(effort));
    const next = await fetch(trail.url, {
      method: 'POST', headers: trail.headers, body: JSON.stringify(body), signal: trail.signal,
    });
    if (!next.ok || !isEventStream(next)) {
      process.stderr.write(`laya: resume #${continues} failed: HTTP ${next.status}\n`);
      return next;
    }
    trail.body = body;
    const resume = { n: continues, effort, unfinished: stop.unfinished, source: stop.source, reasons: stop.reasons };
    trail.resumes.push(resume);
    stats.continued++;
    if (!config.quiet) print(formatContinue({ ...resume, step: turn.steps.length + 1 }));
    return next;
  }

  // Streams the upstream answer. Only a resumable Responses stream is watched for a turn to continue.
  async function relay(res, upstream, { resumable, trail }) {
    if (!resumable) {
      const sniff = usageSniffer(upstream.headers.get('content-type'));
      try {
        await untilClientLeaves(pipeUpstream(res, upstream, (c) => sniff.push(c)));
      } finally {
        sniff.finish();
      }
      return sniff.usage;
    }
    await untilClientLeaves(pipeWithContinuation(res, upstream, {
      onEvent: (event) => {
        trail.usage = event.response?.usage ?? trail.usage;
      },
      onCompleted: (data) => resumeTurn(trail, data),
      onError: (err) => process.stderr.write(`laya: resume failed: ${err.message}\n`),
    }));
    return trail.usage;
  }

  // Codex closes the connection as soon as it has response.completed, which aborts the
  // upstream read; the generation still finished, so it is logged like any other.
  async function untilClientLeaves(piping) {
    try {
      await piping;
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }

  // Stats and the decision log of a routed request, once its answer has been relayed.
  function recordRouted({ sent, session, protocol, nudged, trail, usage, status }) {
    const { reasoning, input, cached } = usageTokens(usage);
    if (reasoning != null && sent.effort) {
      stats.reasoningTokens[sent.effort] = (stats.reasoningTokens[sent.effort] ?? 0) + reasoning;
    }
    stats.inputTokens += input ?? 0;
    stats.cachedTokens += cached ?? 0;
    log.write({
      ts: new Date().toISOString(), session, api: protocol === PROTOCOLS.chat ? 'chat' : 'responses',
      ...sent,
      ...(nudged ? { nudged: true } : {}),
      ...(trail.resumes.length ? { continues: trail.resumes } : {}),
      status, usage,
    });
  }

  async function handleRouted(req, res, raw, protocol) {
    const base = upstreamBase(config, req.headers);
    const url = upstreamUrl(base, req.url);
    let body;
    try {
      // Codex compresses with zstd.
      body = JSON.parse(decode(raw, req.headers['content-encoding']).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected a JSON object');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `laya: bad request body: ${err.message}` } }));
    }

    const requested = body.model;
    const session = protocol.session(body, req.headers);
    const openRouter = openRouterOf(base);
    // OpenRouter drops reasoning params a model lacks, so chat requests there are routed even without one.
    const inject = protocol === PROTOCOLS.chat && openRouter;
    const applyEffort = config.mode !== 'off' && (protocol.wantsReasoning(body) || inject);
    const routeModel = wantsModelRouting(body, config);
    // An alias like laya-auto is not a real model, so the judge runs on the configured one.
    const judgeModel = routeModel ? modelId(config, openRouter) : body.model;
    const judgeTarget = protocol.judge ? { url, headers: forwardHeaders(req.headers), model: judgeModel } : null;
    const turn = protocol.parse(body);
    const decision = await decide(body, turn, { session, judgeTarget, applyEffort, routeModel });
    if (decision) body = rewriteRequest(protocol, body, decision, { applyEffort, inject, openRouter, routeModel });
    body = withPromptCacheKey(body, session, base);
    const reminded = decision && config.nudge && config.mode !== 'off' ? withPlanReminder(protocol, body) : null;
    if (reminded) stats.nudged++;
    body = reminded ?? body;

    const upstreamModel = body.model;
    const sent = decision ? describeSent(decision, { applyEffort, model: upstreamModel, requested }) : null;
    const eventId = sent ? randomUUID() : null;
    if (sent) {
      countSent(sent);
      if (!config.quiet) print(formatDecision(sent));
      log.event?.({ type: 'decision', id: eventId, ts: new Date().toISOString(), ...sent });
    }

    const headers = { ...forwardHeaders(req.headers), 'content-type': 'application/json' };
    const signal = abortOnClose(res);
    const trail = { body, session, url, headers, signal, resumes: [], usage: null };
    try {
      const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      const resumable = sent != null && config.continueTurns && config.mode !== 'off'
        && protocol === PROTOCOLS.responses && body.stream === true
        && upstream.status === 200 && isEventStream(upstream);
      const usage = await relay(res, upstream, { resumable, trail });
      if (sent) {
        recordRouted({ sent, session, protocol, nudged: reminded != null, trail, usage, status: upstream.status });
        log.event?.({ type: 'completed', id: eventId, ts: new Date().toISOString(), status: upstream.status });
      }
    } catch (err) {
      if (sent) log.event?.({ type: 'failed', id: eventId, ts: new Date().toISOString(), error: failureNote(err) });
      throw err;
    }
  }

  async function handle(req, res) {
    stats.requests++;
    if (req.url === '/laya/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...identity, mode: config.mode, ladder: config.ladder, stats, layaCache: layaCacheStats() }));
    }
    const raw = await readBody(req);
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && path.endsWith('/responses')) return handleRouted(req, res, raw, PROTOCOLS.responses);
    if (req.method === 'POST' && path.endsWith('/chat/completions')) return handleRouted(req, res, raw, PROTOCOLS.chat);

    const upstream = await fetch(upstreamUrl(upstreamBase(config, req.headers), req.url), {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body: raw.length ? decode(raw, req.headers['content-encoding']) : undefined,
      signal: abortOnClose(res),
    });
    return pipeUpstream(res, upstream);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err.name === 'AbortError') return;
      if (err instanceof BadRequest && !res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `laya: ${err.message}` } }));
      }
      process.stderr.write(`laya: ${req.method} ${req.url} failed: ${err.message}\n`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `laya proxy: ${err.message}` } }));
      } else {
        res.destroy(err);
      }
    });
  });
  return { server, stats, router };
}

// Per-session effort routing: trajectory -> assessment (laya gated by rules, heuristic or judge) -> hysteresis.
// The session state also remembers how often this turn was resumed after an early stop.
import { parseTurn } from './trajectory.js';
import { assess, nextState, isNewTurn } from './policy.js';
import { judge } from './judge.js';
import { layaDecide, combineEffort } from './decisions.js';

const MAX_SESSIONS = 500;

export function createRouter(config, { judgeFn = judge, decideFn = layaDecide } = {}) {
  const sessions = new Map();
  const ladder = config.ladder;
  const defaultLevel = Math.max(0, ladder.indexOf(config.defaultEffort));

  function remember(key, state) {
    sessions.delete(key);
    sessions.set(key, state);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  async function assessTurn(body, judgeTarget, turn, step) {
    const heuristic = assess(turn, ladder, config.defaultEffort);
    if (config.mode === 'laya') {
      try {
        const d = await decideFn(turn, {
          url: config.decisionUrl,
          apiKey: config.decisionKey,
          model: config.decisionModel,
          timeoutMs: config.decisionTimeoutMs,
          cacheSize: config.decisionCacheSize,
          ladder,
          minConfidence: config.minConfidence,
        });
        const useLaya = turn.steps.length === 0 || d.target > heuristic.target;
        return { a: combineEffort(d, heuristic, turn.steps.length === 0), source: useLaya ? 'laya' : 'heuristic (laya considered)', cost: d.cost,
          suggestions: { laya: ladder[d.target], heuristic: ladder[heuristic.target] } };
      } catch (err) {
        return { a: heuristic, source: `heuristic (laya failed: ${err.message})`, cost: null };
      }
    }
    if (config.mode === 'llm' && judgeTarget && step > 1) {
      try {
        const a = await judgeFn(turn, {
          ...judgeTarget,
          model: config.judgeModel || judgeTarget.model || body.model,
          effort: config.judgeEffort,
          timeoutMs: config.judgeTimeoutMs,
          ladder,
        });
        return { a, source: 'judge', cost: null };
      } catch (err) {
        return { a: heuristic, source: `heuristic (judge failed: ${err.message})`, cost: null };
      }
    }
    return { a: heuristic, source: 'heuristic', cost: null };
  }

  /**
   * @param {object} body Responses or Chat Completions request body
   * @param {string} sessionKey
   * @param {{url:string, headers:Record<string,string>, model?:string}|null} judgeTarget model: what
   *   the judge runs on when LAYA_JUDGE_MODEL is unset (the proxy resolves aliases)
   * @param {object} [turn] parsed trajectory; defaults to the Responses `input`
   * @returns {Promise<{effort:string, from:string|null, step:number, hold:number, reasons:string[],
   *   source:string, cost:number|null, ms:number}>}
   */
  async function route(body, sessionKey, judgeTarget, turn = parseTurn(body.input)) {
    const started = performance.now();
    const step = turn.steps.length + 1;
    const prev = sessions.get(sessionKey);
    const { a, source, cost, suggestions } = await assessTurn(body, judgeTarget, turn, step);
    const fresh = isNewTurn(prev, step);
    let state = nextState(prev, a, step);
    const continues = fresh ? 0 : prev.continues ?? 0;
    if (continues > 0 && state.level < defaultLevel) {
      // The model already tried to stop early this turn; low effort is where it gets lazy.
      state = { ...state, level: defaultLevel, reasons: [...state.reasons, 'resumed turn keeps default effort'] };
    }
    remember(sessionKey, { ...state, continues });
    return {
      effort: ladder[state.level],
      from: state.from == null ? null : ladder[state.from],
      step,
      hold: state.hold,
      reasons: state.reasons,
      source,
      ...(suggestions ? { suggestions } : {}),
      ...(state.level !== a.target ? { adjustment: 'session policy' } : {}),
      cost,
      ms: Math.round(performance.now() - started),
    };
  }

  /** How many times this session's current turn was resumed after an early stop. */
  function continuesOf(sessionKey) {
    return sessions.get(sessionKey)?.continues ?? 0;
  }

  /**
   * Records that the proxy resumed the current turn, and returns the effort for the
   * resumed generation: one rung above the last one, at least the default.
   * @returns {{continues:number, effort:string}}
   */
  function noteContinue(sessionKey) {
    const prev = sessions.get(sessionKey) ?? { level: defaultLevel, hold: 0, step: 1, continues: 0 };
    const level = Math.min(ladder.length - 1, Math.max(defaultLevel, prev.level + 1));
    const continues = (prev.continues ?? 0) + 1;
    remember(sessionKey, { ...prev, level, continues });
    return { continues, effort: ladder[level] };
  }

  return { route, continuesOf, noteContinue, sessions };
}

---
name: laya-gpt
description: Use when the user asks about laya-gpt, the "[laya]" developer messages in the conversation, reasoning effort routing (low..xhigh), the laya-gpt proxy status or stats, or wants laya-gpt started, stopped, or set up.
---

# laya-gpt: the proxy that routes effort and keeps long tasks going

laya-gpt sits between Codex and one GPT model (default `gpt-6.1-terra`). Before each
generation a local laya model picks the reasoning effort (low, medium, high, xhigh). A
new turn starts at medium. When the model ends a turn early with work still open, the
proxy resumes it, and while plan steps are open it adds a reminder before each generation.

## What a `[laya]` message means

A developer message starting with `[laya]` comes from the proxy, not from the user.

- "N of M plan steps done" with open steps: finish those steps, verify the result, then end the turn.
- "You ended your turn but the task is not finished": continue the same task from where it stopped.
- Do not ask "shall I continue?" or wait for permission. Keep working until the plan is done and verified, or until you truly need something only the user can give (a key, a password, a choice).

## Commands

Run these in a shell; they work from any directory once laya-gpt is installed.

| Command | Purpose |
|---|---|
| `laya-gpt status` | Version of the running proxy; exit 1 if stale or not running |
| `laya-gpt stats` | Generations per effort, reasoning tokens, resumed early stops, prompt-cache hit rate |
| `laya-gpt tail` | Follow routing decisions live |
| `laya-gpt serve` | Run the proxy in the foreground (port 8790) |
| `laya-gpt stop` | Stop the proxy, and the laya it started |
| `laya-gpt setup` | Install laya-deploy (clone, `uv sync`, download the checkpoint) |
| `laya-gpt skills` | Install these skills into `$CODEX_HOME/skills` (add `--claude` for `~/.claude/skills`) |
| `laya-gpt codex` | Start the proxy if needed, then run `codex -p layagpt` |

## Health checks

- Proxy: `http://127.0.0.1:8790/laya/health` (reports `app`, `version`, `mode`, `stats`)
- laya: `http://127.0.0.1:8100/health` (reports `loaded` models)

If the proxy is not answering, start it with `laya-gpt serve` (or `laya-gpt codex`, which starts it in the background). If laya is not answering, decisions fall back to the built-in rules. This is not an error; `laya-gpt status` shows which state applies.

## Questions about laya itself

For anything about the laya model or laya-deploy (its API, checkpoints, decision mode, the
server), use the `laya-decisions` skill. This skill covers only the laya-gpt proxy and its
commands.

## Key settings

`LAYA_PORT` (8790), `LAYA_DEFAULT_EFFORT` (medium), `LAYA_NUDGE` (on|off), `LAYA_CONTINUE`
(on|off), `LAYA_MAX_CONTINUES` (5), `LAYA_CONTINUE_THRESHOLD` (0.6), `LAYA_AUTOSTART`
(on|off), `LAYA_DECISION_URL`. Setting `LAYA_DECISION_URL` to a non-local address disables
autostart.

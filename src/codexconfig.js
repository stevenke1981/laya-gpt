// Edits Codex's main config.toml so clients that cannot pass `-p` (the Codex desktop app,
// IDE extensions) also go through the proxy. The edit is reversible without a TOML parser:
// laya-gpt's lines sit between marker comments, and each top-level key it replaces is
// kept as a comment that `removeGlobal` turns back into the original line.
// Pure: text in, text out.

export const PROVIDER = 'layagpt';
const BEGIN = '# >>> laya-gpt (remove with: laya-gpt uninstall)';
const END = '# <<< laya-gpt';
const SAVED = '# laya-gpt saved: ';
const REPLACED_KEYS = /^\s*(?:model|model_provider|model_reasoning_effort)\s*=/;
const TABLE = /^\s*\[/;
const OUR_TABLE = new RegExp(`^\\s*\\[\\s*model_providers\\.${PROVIDER}\\s*\\]`);

function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return { eol, lines };
}

function join(lines, eol) {
  return lines.length ? lines.join(eol) + eol : '';
}

/** Whether laya-gpt's block is in the config text. */
export function hasGlobal(text) {
  return String(text ?? '').split(/\r?\n/).includes(BEGIN);
}

/** Drops laya-gpt's blocks and restores the lines it commented out. */
export function removeGlobal(text) {
  const { eol, lines } = splitLines(String(text ?? ''));
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line === BEGIN) inside = true;
    else if (line === END) inside = false;
    else if (!inside) out.push(line.startsWith(SAVED) ? line.slice(SAVED.length) : line);
  }
  return join(out, eol);
}

/**
 * Makes laya-gpt the default provider of a Codex config.toml. Running it again replaces
 * the earlier edit. Throws when the file defines its own [model_providers.layagpt].
 * @param {string} text the current config.toml ('' when there is none)
 * @param {{host:string, port:number, model:string, defaultEffort:string}} config
 */
export function addGlobal(text, config) {
  const { eol, lines } = splitLines(removeGlobal(text));
  if (lines.some((line) => OUR_TABLE.test(line))) {
    throw new Error(`config.toml already defines [model_providers.${PROVIDER}]; remove it first`);
  }
  const firstTable = lines.findIndex((line) => TABLE.test(line));
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  // Top-level keys must come before the first table, so ours go first and the ones they
  // replace become comments.
  const top = lines.slice(0, topEnd).map((line) => (REPLACED_KEYS.test(line) ? SAVED + line : line));
  const head = [
    BEGIN,
    `model_provider = "${PROVIDER}"`,
    `model = "${config.model}"`,
    `model_reasoning_effort = "${config.defaultEffort}"`,
    END,
  ];
  const table = [
    BEGIN,
    `[model_providers.${PROVIDER}]`,
    'name = "Laya GPT"',
    `base_url = "http://${config.host}:${config.port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    END,
  ];
  return join([...head, ...top, ...lines.slice(topEnd), ...table], eol);
}

import fs from 'node:fs';
import path from 'node:path';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { blue: '\x1b[34m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { blue: '', green: '', dim: '', bold: '', reset: '' };

// "LOW → MEDIUM", or just the effort when nothing changed; "MODEL" when only the model was set.
function effortLevels(d) {
  if (!d.effort) return 'MODEL';
  return d.from && d.from !== d.effort
    ? `${d.from.toUpperCase()} → ${d.effort.toUpperCase()}`
    : d.effort.toUpperCase();
}

// Mirrors the in-task status line: "Laya  LOW → MEDIUM  ✓ APPLIED".
export function formatDecision(d) {
  const levels = effortLevels(d);
  const reasons = d.reasons ?? [];
  const gens = Math.max(1, d.hold);
  const detail = [`Step ${d.step}`, ...(d.source ? [`source: ${d.source}`] : []), ...(d.effort ? [`next ${gens} generation(s)`] : []), `${d.ms} ms`, reasons.join('; ')];
  return `${C.blue}Laya${C.reset}  ${C.bold}${levels}${C.reset}  ${C.green}✓ APPLIED${C.reset}\n`
    + `${C.dim}     ${detail.join(' · ')}${C.reset}`;
}

// The resume line: "Laya  RESUME #2 → HIGH  ✓ APPLIED", then the step, unfinished score and reasons.
export function formatContinue(c) {
  const detail = [`Step ${c.step}`, `unfinished ${c.unfinished.toFixed(2)}`, c.source, (c.reasons ?? []).join('; ')];
  return `${C.blue}Laya${C.reset}  ${C.bold}RESUME #${c.n} → ${c.effort.toUpperCase()}${C.reset}  ${C.green}✓ APPLIED${C.reset}\n`
    + `${C.dim}     ${detail.filter(Boolean).join(' · ')}${C.reset}`;
}

export function createDecisionLog(config) {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  return {
    write(record) {
      fs.appendFile(config.logFile, `${JSON.stringify(record)}\n`, (err) => {
        if (err) process.stderr.write(`laya: cannot write ${config.logFile}: ${err.message}\n`);
      });
    },
  };
}

export function readDecisions(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// Responses reports `output_tokens_details`, Chat Completions `completion_tokens_details`.
export function usageTokens(usage) {
  return {
    reasoning: usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? null,
    output: usage?.output_tokens ?? usage?.completion_tokens ?? null,
  };
}

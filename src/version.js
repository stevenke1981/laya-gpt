// Identifies the code a proxy runs, so the CLI can spot a proxy started before
// an update (`git pull`, branch switch) that is still serving old behavior.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['src', 'bin'];

export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// Content hash, not mtime: a checkout that rewrites identical files keeps the build.
// Line endings are normalized so autocrlf does not change it.
function computeBuild() {
  const files = SOURCE_DIRS.flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f)))
    .concat('package.json')
    .sort();
  const hash = crypto.createHash('sha1');
  for (const rel of files) {
    hash.update(rel.replaceAll('\\', '/')).update('\0');
    hash.update(fs.readFileSync(path.join(ROOT, rel), 'utf8').replaceAll('\r\n', '\n')).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

export const BUILD = computeBuild();

// Identity a proxy reports in /laya/health. Only a payload carrying this exact id is ours:
// `status` and `stop` never signal a process that answers with anything else.
export const APP = 'laya-gpt';

/** @returns {boolean} true only when the /laya/health payload says it is this project's proxy */
export function isOurProxy(health) {
  return health?.app === APP;
}

/**
 * Compares a running proxy's /laya/health payload with the code on disk.
 * @returns {{status: 'current'|'stale', message: string}}
 */
export function compareBuild(health, local = { version: VERSION, build: BUILD }) {
  const running = health?.build
    ? `v${health.version} build ${health.build}, pid ${health.pid}, started ${health.startedAt}`
    : 'an older version without build info';
  if (health?.build === local.build) return { status: 'current', message: `running ${running} (current)` };
  return {
    status: 'stale',
    message: `the running proxy is ${running}, but the code on disk is v${local.version} build ${local.build}; `
      + 'stop it and rerun "laya-gpt serve" so it picks up the update',
  };
}

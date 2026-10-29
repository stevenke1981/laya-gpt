// Runs the local laya server (laya-deploy, Python) for laya-gpt: finds its checkout, starts
// it with the checkpoint laya-gpt asks for preloaded, and stops the one it started. The
// Python code stays in its own checkout (`laya-gpt setup` clones it), so laya-gpt keeps no
// dependencies. Only a server on this machine (loopback URL) is ever started or stopped.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEPLOY_REPO = 'https://github.com/stevenke1981/laya-deploy.git';
const DIR_FILE = 'laya-deploy.dir';
const PID_FILE = 'laya.pid';
const LOG_FILE = 'laya.log';
const HEALTH_TIMEOUT_MS = 1000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Host, port and health URL of the decisions endpoint; local is true for loopback only. */
export function layaEndpoint(decisionUrl) {
  const url = new URL(decisionUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return { host: url.hostname, port, health: `${url.origin}/health`, local: url.protocol === 'http:' && LOOPBACK.has(url.hostname) };
}

/** The laya-deploy checkout: LAYA_DEPLOY_DIR, else the one `setup` recorded, else <home>/laya-deploy. */
export function deployDir(env, home) {
  if (env.LAYA_DEPLOY_DIR) return path.resolve(env.LAYA_DEPLOY_DIR);
  try {
    const saved = fs.readFileSync(path.join(home, DIR_FILE), 'utf8').trim();
    if (saved) return saved;
  } catch {
    // No recorded checkout.
  }
  return path.join(home, 'laya-deploy');
}

/** Remembers the checkout `setup` used, so later commands find it without an env var. */
export function rememberDeployDir(home, dir) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, DIR_FILE), `${path.resolve(dir)}\n`);
}

/** The checkout's virtualenv Python (`uv sync` creates it); LAYA_DEPLOY_PYTHON overrides. */
export function venvPython(dir, env = process.env, platform = process.platform) {
  if (env.LAYA_DEPLOY_PYTHON) return env.LAYA_DEPLOY_PYTHON;
  return platform === 'win32' ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
}

/**
 * The Python that serves laya in the background. On Windows a venv's python.exe is a
 * launcher that starts the real interpreter as a child; started detached it has no console,
 * so that child would open a console window of its own. pythonw.exe starts it windowless,
 * and stopping the launcher still stops the server.
 */
export function serverPython(dir, env = process.env, platform = process.platform) {
  if (env.LAYA_DEPLOY_PYTHON || platform !== 'win32') return venvPython(dir, env, platform);
  return path.join(dir, '.venv', 'Scripts', 'pythonw.exe');
}

/**
 * How to start laya-deploy for this config. Python is run directly (not through `uv run` or
 * the laya-deploy .exe launcher), so the PID laya-gpt records stops the server.
 * Environment beats the checkout's .env, so the bind address, port, token and preloaded
 * checkpoint always match what laya-gpt will call.
 */
export function serveCommand(config, dir, env = process.env, platform = process.platform) {
  const { port } = layaEndpoint(config.decisionUrl);
  return {
    file: serverPython(dir, env, platform),
    args: ['-m', 'laya_deploy.cli', 'serve'],
    cwd: dir,
    env: {
      ...env,
      LAYA_DEPLOY_HOST: '127.0.0.1',
      LAYA_DEPLOY_PORT: String(port),
      LAYA_DEPLOY_PRELOAD: config.decisionModel === 'auto' ? 'english,multilingual' : config.decisionModel,
      ...(config.decisionKey ? { LAYA_DEPLOY_API_KEY: config.decisionKey } : {}),
      PYTHONIOENCODING: 'utf-8',
    },
  };
}

/** The laya server's /health payload, or null when nothing answers. */
export async function layaHealth(config) {
  try {
    const res = await fetch(layaEndpoint(config.decisionUrl).health, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.status === 'ok' ? body : null;
  } catch {
    return null;
  }
}

function pidFile(config) {
  return path.join(config.home, PID_FILE);
}

/** The PID of the laya server laya-gpt started, if it still runs. */
export function startedPid(config) {
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(pidFile(config), 'utf8')).pid;
  } catch {
    return null;
  }
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.rmSync(pidFile(config), { force: true });
    return null;
  }
}

/**
 * Makes sure a laya server will answer: does nothing when one does (or one laya-gpt started
 * is still loading), starts one from the checkout otherwise. Never waits for the model to
 * load; until it answers, decisions fall back to the rules.
 * @returns {Promise<{state:'off'|'remote'|'running'|'loading'|'started'|'missing', detail:string}>}
 */
export async function ensureLaya(config, { env = process.env, spawnFn = spawn, platform = process.platform } = {}) {
  if (config.mode !== 'laya' || !config.layaAutostart) return { state: 'off', detail: 'autostart off' };
  const endpoint = layaEndpoint(config.decisionUrl);
  if (!endpoint.local) return { state: 'remote', detail: `${endpoint.health} is not on this machine; start it yourself` };
  const health = await layaHealth(config);
  if (health) {
    const loaded = Array.isArray(health.loaded) ? health.loaded : [];
    const ready = config.decisionModel === 'auto' || loaded.includes(config.decisionModel);
    return { state: 'running', detail: ready ? `loaded ${loaded.join(', ')}` : `"${config.decisionModel}" not loaded yet; the first decision loads it` };
  }
  const pid = startedPid(config);
  if (pid) return { state: 'loading', detail: `pid ${pid} is still loading; see ${path.join(config.home, LOG_FILE)}` };
  const dir = deployDir(env, config.home);
  const cmd = serveCommand(config, dir, env, platform);
  if (!fs.existsSync(cmd.file)) return { state: 'missing', detail: `no laya-deploy at ${dir}; run: laya-gpt setup` };
  fs.mkdirSync(config.home, { recursive: true });
  const out = fs.openSync(path.join(config.home, LOG_FILE), 'a');
  const child = spawnFn(cmd.file, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  fs.closeSync(out);
  child.unref?.();
  fs.writeFileSync(pidFile(config), JSON.stringify({ pid: child.pid, url: config.decisionUrl, startedAt: new Date().toISOString() }));
  return { state: 'started', detail: `pid ${child.pid}, loading "${cmd.env.LAYA_DEPLOY_PRELOAD}"; log: ${path.join(config.home, LOG_FILE)}` };
}

/** Stops the laya server laya-gpt started; one started by hand is left alone. */
export function stopLaya(config) {
  const pid = startedPid(config);
  fs.rmSync(pidFile(config), { force: true });
  if (!pid) return null;
  try {
    process.kill(pid);
  } catch (err) {
    if (err.code !== 'ESRCH') throw new Error(`cannot stop laya pid ${pid}: ${err.message}`);
  }
  return pid;
}

// Installs agent skills (folders with a SKILL.md) for Codex and Claude Code. Sources are the
// skills shipped in this repo and in the laya-deploy checkout. Every installed copy gets a
// MARKER file, so reinstalling replaces only our copies and removal never touches a skill
// someone else wrote.
import fs from 'node:fs';
import path from 'node:path';

export const MARKER = '.laya-gpt-skill';

/** Subdirectories of root that contain a SKILL.md, sorted by name; [] when root is missing. */
function skillDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => ({ name: e.name, dir: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills to install: every <repoDir>/skills and <deployDir>/skills subfolder with a SKILL.md.
 * Repo skills come first; the first skill with a given name wins.
 * @returns {{name: string, dir: string}[]}
 */
export function skillSources(repoDir, deployDir) {
  const seen = new Set();
  const out = [];
  for (const root of [path.join(repoDir, 'skills'), path.join(deployDir, 'skills')]) {
    for (const skill of skillDirs(root)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

/**
 * Copies each skill to <targetRoot>/<name>, replacing an earlier copy of ours. A directory
 * without MARKER is someone else's: it is skipped, or replaced when force is set.
 * @returns {{installed: string[], skipped: string[]}}
 */
export function installSkills(sources, targetRoot, { force = false } = {}) {
  fs.mkdirSync(targetRoot, { recursive: true });
  const installed = [];
  const skipped = [];
  for (const { name, dir } of sources) {
    const target = path.join(targetRoot, name);
    if (fs.existsSync(target)) {
      if (!force && !fs.existsSync(path.join(target, MARKER))) {
        skipped.push(name);
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.cpSync(dir, target, { recursive: true });
    fs.writeFileSync(path.join(target, MARKER), `${dir}\n`);
    installed.push(name);
  }
  return { installed, skipped };
}

/**
 * Deletes the skills under targetRoot that carry MARKER; other folders are left alone.
 * @returns {string[]} the names removed
 */
export function removeSkills(targetRoot) {
  let entries;
  try {
    entries = fs.readdirSync(targetRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const e of entries) {
    const target = path.join(targetRoot, e.name);
    if (!e.isDirectory() || !fs.existsSync(path.join(target, MARKER))) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed.sort();
}

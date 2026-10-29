import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER, skillSources, installSkills, removeSkills } from '../src/skills.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'laya-gpt-skills-test-'));
}

/** Writes skills/<name>/SKILL.md (plus an extra file) under root. */
function writeSkill(root, name, body = `# ${name}\n`) {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  fs.writeFileSync(path.join(dir, 'refs', 'notes.md'), 'notes\n');
  return dir;
}

test('skillSources lists skill folders from the repo first, then deploy, without duplicates', () => {
  const repo = tempDir();
  const deploy = tempDir();
  try {
    writeSkill(repo, 'laya-gpt');
    writeSkill(repo, 'shared', 'repo version\n');
    writeSkill(deploy, 'laya-decisions');
    writeSkill(deploy, 'shared', 'deploy version\n');
    fs.mkdirSync(path.join(deploy, 'skills', 'no-skillmd'));
    fs.writeFileSync(path.join(deploy, 'skills', 'loose.md'), 'not a folder\n');

    const sources = skillSources(repo, deploy);
    assert.deepEqual(sources.map((s) => s.name), ['laya-gpt', 'shared', 'laya-decisions']);
    assert.equal(sources[1].dir, path.join(repo, 'skills', 'shared'));
    assert.equal(sources[0].dir, path.join(repo, 'skills', 'laya-gpt'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(deploy, { recursive: true, force: true });
  }
});

test('skillSources skips missing skills folders', () => {
  const repo = tempDir();
  try {
    assert.deepEqual(skillSources(repo, path.join(repo, 'missing')), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('installSkills copies skill folders and writes the marker with the source path', () => {
  const src = tempDir();
  const base = tempDir();
  const codexSkills = path.join(base, 'codex', 'skills');
  try {
    writeSkill(src, 'laya-gpt');
    const sources = skillSources(src, path.join(src, 'missing'));
    const { installed, skipped } = installSkills(sources, codexSkills);
    assert.deepEqual(installed, ['laya-gpt']);
    assert.deepEqual(skipped, []);
    const target = path.join(codexSkills, 'laya-gpt');
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), '# laya-gpt\n');
    assert.equal(fs.readFileSync(path.join(target, 'refs', 'notes.md'), 'utf8'), 'notes\n');
    assert.equal(fs.readFileSync(path.join(target, MARKER), 'utf8'), `${path.join(src, 'skills', 'laya-gpt')}\n`);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reinstalling replaces our own copy', () => {
  const src = tempDir();
  const root = tempDir();
  try {
    writeSkill(src, 'laya-gpt', 'version one\n');
    const sources = skillSources(src, path.join(src, 'missing'));
    installSkills(sources, root);
    fs.writeFileSync(path.join(src, 'skills', 'laya-gpt', 'SKILL.md'), 'version two\n');
    fs.rmSync(path.join(src, 'skills', 'laya-gpt', 'refs'), { recursive: true });
    const again = installSkills(sources, root);
    assert.deepEqual(again.installed, ['laya-gpt']);
    const target = path.join(root, 'laya-gpt');
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'version two\n');
    assert.ok(!fs.existsSync(path.join(target, 'refs')), 'stale file from the earlier copy survived');
    assert.ok(fs.existsSync(path.join(target, MARKER)));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign directory is skipped unless force is set, then overwritten', () => {
  const src = tempDir();
  const root = tempDir();
  try {
    writeSkill(src, 'laya-gpt', 'ours\n');
    const foreign = path.join(root, 'laya-gpt');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'hand written\n');
    const sources = skillSources(src, path.join(src, 'missing'));

    const skipped = installSkills(sources, root);
    assert.deepEqual(skipped, { installed: [], skipped: ['laya-gpt'] });
    assert.equal(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), 'hand written\n');
    assert.ok(!fs.existsSync(path.join(foreign, MARKER)));

    const forced = installSkills(sources, root, { force: true });
    assert.deepEqual(forced, { installed: ['laya-gpt'], skipped: [] });
    assert.equal(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), 'ours\n');
    assert.ok(fs.existsSync(path.join(foreign, MARKER)));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeSkills removes only directories carrying the marker', () => {
  const src = tempDir();
  const root = tempDir();
  try {
    writeSkill(src, 'laya-gpt');
    writeSkill(src, 'laya-decisions');
    installSkills(skillSources(src, path.join(src, 'missing')), root);
    const foreign = path.join(root, 'theirs');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'mine\n');
    fs.writeFileSync(path.join(root, 'loose.txt'), 'x\n');

    assert.deepEqual(removeSkills(root), ['laya-decisions', 'laya-gpt']);
    assert.deepEqual(fs.readdirSync(root).sort(), ['loose.txt', 'theirs']);
    assert.equal(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), 'mine\n');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeSkills returns [] when the target root is missing', () => {
  const root = path.join(tempDir(), 'absent');
  assert.deepEqual(removeSkills(root), []);
});

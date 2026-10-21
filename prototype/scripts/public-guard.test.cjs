'use strict';

// Run: node --test prototype/scripts/public-guard.test.cjs
// Only temporary repositories are committed to; no push or network operation is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '../..');
const EMAIL = '35388022+Zihao-Qi@users.noreply.github.com';
const ZERO = '0'.repeat(40);
const LIST = '# ignored comment\n\n Zorblat \r\nAmber Noodle\n/ZorbUsers/\nDesktop/ZorbRA\nFlim-Flam\nZorb[dot]+\n';
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};

function command(cwd, executable, args, options = {}) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', env: ENV, ...options });
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}
function blocked(result, pattern) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, pattern);
}
function repo(t, { seed = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hearalong-guard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = {
    root,
    git(...args) {
      const result = command(root, 'git', args);
      ok(result);
      return result.stdout.trim();
    },
    write(file, content) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
    stage(file, content) {
      this.write(file, content);
      this.git('add', '-f', '--', file);
    },
    commit(verify = true, env = {}) {
      const result = command(root, 'git', ['commit', ...(verify ? [] : ['--no-verify']), '-m', 'fixture'], { env: { ...ENV, ...env } });
      ok(result);
      return this.git('rev-parse', 'HEAD');
    },
    hook(mode, input = '', cwd = root, args = mode === 'pre-push' ? ['origin', 'unused'] : []) {
      return command(cwd, path.join(root, '.githooks', mode), args, { input });
    },
    push(tip = this.git('rev-parse', 'HEAD'), base = ZERO, remote = 'origin') {
      return this.hook('pre-push', `refs/heads/main ${tip} refs/heads/main ${base}\n`, root, [remote, 'unused']);
    },
  };
  r.git('init', '--initial-branch=main');
  r.git('config', 'user.name', 'Guard Fixture');
  r.git('config', 'user.email', EMAIL);
  r.git('config', 'core.hooksPath', path.join(root, '.githooks'));
  r.git('config', 'commit.gpgSign', 'false');
  fs.cpSync(path.join(SOURCE, '.githooks'), path.join(root, '.githooks'), { recursive: true });
  r.write('private/public-denylist.txt', LIST);
  if (seed) {
    r.stage('.gitignore', 'private/\n.githooks/\n');
    r.stage('base.txt', 'initial\n');
    r.commit();
  }
  return r;
}

test('setup command installs executable hooks from prototype/', t => {
  const r = repo(t);
  r.git('config', '--unset', 'core.hooksPath');
  r.write('prototype/package.json', fs.readFileSync(path.join(SOURCE, 'prototype/package.json')));
  ok(command(path.join(r.root, 'prototype'), 'npm', ['run', 'guard:install']));
  assert.equal(r.git('config', '--get', 'core.hooksPath'), path.join(r.root, '.githooks'));
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    assert.ok(fs.statSync(path.join(r.root, '.githooks', hook)).mode & 0o111);
  }
  ok(r.hook('pre-commit', '', path.join(r.root, 'prototype')));
  r.stage('blocked.txt', 'Zorblat\n');
  blocked(command(r.root, 'git', ['commit', '-m', 'must fail']), /deny-list term/);
});

test('first commit and clean push pass without a remote base', t => {
  const r = repo(t, { seed: false });
  r.stage('first.txt', 'public fixture\n');
  ok(r.hook('pre-commit'));
  r.commit();
  ok(r.push());
});

for (const text of ['preZorblatpost', 'Zorblat7', '_Zorblat', 'Zorblat_', 'éZorblat', 'Zorblaté', '# ignored comment']) {
  test(`whole-word nonmatch: ${text}`, t => {
    const r = repo(t);
    r.stage('words.txt', `${text}\n`);
    ok(r.hook('pre-commit'));
  });
}
for (const [text, term] of [
  ['(zOrBlAt)!', 'Zorblat'], ['AMBER noodle', 'Amber Noodle'],
  ['/ZORBusers/person/docs', '/ZorbUsers/'], ['desktop/zorbra/file', 'Desktop/ZorbRA'],
  ['flim-FLAM', 'Flim-Flam'], ['Zorb[dot]+', 'Zorb[dot]+'],
]) {
  test(`literal, case-insensitive match: ${term}`, t => {
    const r = repo(t);
    r.stage('name with spaces.txt', `safe\n${text}\n`);
    const result = r.hook('pre-commit');
    blocked(result, /"name with spaces.txt":2: deny-list term/);
    assert.ok(result.stderr.includes(JSON.stringify(term)));
  });
}

test('only added lines count; unchanged and deleted terms pass', t => {
  const r = repo(t);
  r.stage('legacy.txt', 'Zorblat\nAmber Noodle\nsafe\n');
  r.commit(false);
  r.stage('legacy.txt', 'Zorblat\nsafe\nnew public line\n');
  ok(r.hook('pre-commit'));
  r.stage('legacy.txt', 'safe\n');
  ok(r.hook('pre-commit'));
});

test('staged contents, not working-tree contents, determine the result', t => {
  const r = repo(t);
  r.stage('staged.txt', 'safe\n');
  r.write('staged.txt', 'Zorblat\n');
  ok(r.hook('pre-commit'));
  r.git('add', 'staged.txt');
  r.write('staged.txt', 'safe\n');
  blocked(r.hook('pre-commit'), /deny-list term/);
});

test('binary additions and modifications are scanned despite diff attributes/helpers', t => {
  const r = repo(t);
  r.stage('.gitattributes', '*.bin -diff\n');
  r.stage('payload.bin', Buffer.from('\0safe\n'));
  r.commit();
  r.git('config', 'diff.external', 'false');
  r.stage('payload.bin', Buffer.from('\0safe\nZorblat\0\n'));
  blocked(r.hook('pre-commit'), /"payload.bin":2: deny-list term/);
  r.stage('payload.bin', Buffer.from('\0safe\n'));
  r.stage('new binary.bin', Buffer.from('\0Amber Noodle\0'));
  blocked(r.hook('pre-commit'), /"new binary.bin":1: deny-list term/);
});

test('pure renames add no lines, but renamed destinations still enforce file rules', t => {
  const r = repo(t);
  r.stage('old.txt', 'Zorblat\n');
  r.commit(false);
  r.git('mv', 'old.txt', 'renamed with spaces.txt');
  ok(r.hook('pre-commit'));
  r.git('mv', 'renamed with spaces.txt', 'renamed.WAV');
  blocked(r.hook('pre-commit'), /blocked extension/);
  r.git('mv', 'renamed.WAV', 'old.txt');
  fs.mkdirSync(path.join(r.root, 'evaluation'));
  r.git('mv', 'old.txt', 'evaluation/renamed.txt');
  blocked(r.hook('pre-commit'), /private\/runtime path/);
});

test('rename with modifications reports the new path and added line number', t => {
  const r = repo(t);
  r.stage('old.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  r.commit();
  r.git('mv', 'old.txt', 'new name.txt');
  r.stage('new name.txt', 'one\ntwo\nthree\nZorblat\nfive\nsix\n');
  blocked(r.hook('pre-commit'), /"new name.txt":4: deny-list term/);
});

for (const file of [
  'private/notes.txt', 'data/notes.txt', 'evaluation/notes.txt',
  'prototype/data/notes.txt', 'prototype/artifacts/notes.txt',
  'nested/prototype/data/notes.txt', 'nested/prototype/artifacts/notes.txt',
]) {
  test(`runtime path blocked: ${file}`, t => {
    const r = repo(t);
    r.stage(file, 'safe\n');
    blocked(r.hook('pre-commit'), /private\/runtime path/);
  });
}
for (const extension of ['wav', 'f32', 'sqlite', 'db', 'm4a', 'mp3', 'mp4', 'webm', 'gguf', 'media', 'WAV']) {
  test(`extension blocked: ${extension}`, t => {
    const r = repo(t);
    r.stage(`sample.${extension}`, 'safe\n');
    blocked(r.hook('pre-commit'), /blocked extension/);
  });
}

test('size limit uses staged blobs, including the exact 2 MB boundary', t => {
  const r = repo(t);
  r.stage('large.txt', Buffer.alloc(2_000_000, 120));
  r.write('large.txt', Buffer.alloc(2_000_001, 120));
  ok(r.hook('pre-commit'));
  r.git('add', 'large.txt');
  r.write('large.txt', 'safe');
  blocked(r.hook('pre-commit'), /larger than 2 MB/);
});

test('deleting forbidden files is allowed', t => {
  const r = repo(t);
  r.stage('data/old.wav', 'Zorblat\n');
  r.commit(false);
  const base = r.git('rev-parse', 'HEAD');
  r.git('rm', 'data/old.wav');
  ok(r.hook('pre-commit'));
  const tip = r.commit();
  ok(r.push(tip, base));
});

test('filenames with tabs and newlines are safely reported', t => {
  const r = repo(t);
  const name = 'odd\tfile\nname.txt';
  r.stage(name, 'Zorblat\n');
  const result = r.hook('pre-commit');
  blocked(result, /deny-list term/);
  assert.ok(result.stderr.includes(`${JSON.stringify(name)}:1:`));
});

test('symlink target is inspected; gitlinks fail closed rather than being skipped', t => {
  const r = repo(t);
  fs.symlinkSync('Zorblat', path.join(r.root, 'link'));
  r.git('add', 'link');
  blocked(r.hook('pre-commit'), /"link":1: deny-list term/);
  r.git('rm', '--cached', 'link');
  r.git('update-index', '--add', '--cacheinfo', `160000,${r.git('rev-parse', 'HEAD')},library`);
  blocked(r.hook('pre-commit'), /cannot inspect submodule/);
});

test('pre-commit rejects wrong and unset configured email', t => {
  const r = repo(t);
  r.git('config', 'user.email', 'fixture@example.invalid');
  blocked(r.hook('pre-commit'), /set git config user.email/);
  r.git('config', '--unset', 'user.email');
  blocked(r.hook('pre-commit'), /set git config user.email/);
});

for (const identity of ['AUTHOR', 'COMMITTER']) {
  test(`pre-push rejects wrong ${identity.toLowerCase()} from a --no-verify commit`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    r.stage('new.txt', 'safe\n');
    const tip = r.commit(false, { [`GIT_${identity}_EMAIL`]: 'fixture@example.invalid' });
    blocked(r.push(tip, base), /author\/committer email must be/);
  });
}

test('pre-push catches a forbidden intermediate --no-verify commit even after removal', t => {
  const r = repo(t);
  const base = r.git('rev-parse', 'HEAD');
  r.stage('leak.txt', 'Zorblat\n');
  const bad = r.commit(false);
  r.git('rm', 'leak.txt');
  const tip = r.commit();
  const result = r.push(tip, base);
  blocked(result, /deny-list term/);
  assert.ok(result.stderr.includes(bad.slice(0, 12)));
});

for (const [file, content, pattern] of [
  ['prototype/data/item.txt', 'safe', /private\/runtime path/],
  ['clip.mp3', Buffer.from('\0safe'), /blocked extension/],
  ['large.txt', Buffer.alloc(2_000_001, 120), /larger than 2 MB/],
]) {
  test(`pre-push applies file rules to history: ${file}`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    r.stage(file, content);
    const tip = r.commit(false);
    blocked(r.push(tip, base), pattern);
  });
}

test('new branch without remote refs checks every ancestor, including the root', t => {
  const r = repo(t, { seed: false });
  r.stage('root.txt', 'safe\n');
  const bad = r.commit(false, { GIT_AUTHOR_EMAIL: 'fixture@example.invalid' });
  r.stage('later.txt', 'safe\n');
  r.commit();
  const result = r.push();
  blocked(result, /author\/committer email must be/);
  assert.ok(result.stderr.includes(bad.slice(0, 12)));
});

test('new branch excludes ancestors on any branch of the destination remote', t => {
  const r = repo(t);
  r.stage('legacy.txt', 'Zorblat\n');
  const remoteBase = r.commit(false);
  r.git('update-ref', 'refs/remotes/origin/shared', remoteBase);
  r.stage('later.txt', 'safe\n');
  r.commit();
  ok(r.push());
});

test('merge-only additions are checked', t => {
  const r = repo(t);
  const base = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-b', 'side');
  r.stage('side.txt', 'safe\n');
  r.commit();
  r.git('checkout', 'main');
  r.stage('main.txt', 'safe\n');
  r.commit();
  r.git('merge', '--no-commit', '--no-ff', 'side');
  r.stage('merge.txt', 'Zorblat\n');
  const merge = r.commit(false);
  const result = r.push(merge, base);
  blocked(result, /"merge.txt":1: deny-list term/);
  assert.ok(result.stderr.includes(merge.slice(0, 12)));
});

test('side-branch violations are caught even when absent from the merge tree', t => {
  const r = repo(t);
  const base = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-b', 'side');
  r.stage('side-leak.txt', 'Zorblat\n');
  const bad = r.commit(false);
  r.git('rm', 'side-leak.txt');
  r.commit();
  r.git('checkout', 'main');
  r.stage('main.txt', 'safe\n');
  r.commit();
  r.git('merge', '--no-ff', '-m', 'fixture merge', 'side');
  const result = r.push(undefined, base);
  blocked(result, /deny-list term/);
  assert.ok(result.stderr.includes(bad.slice(0, 12)));
});

test('shallow history fails closed instead of skipping ancestors', t => {
  const r = repo(t);
  r.stage('later.txt', 'safe\n');
  r.commit();
  const shallow = `${r.root}-shallow`;
  t.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
  r.git('clone', '--depth', '1', `file://${r.root}`, shallow);
  fs.cpSync(path.join(SOURCE, '.githooks'), path.join(shallow, '.githooks'), { recursive: true });
  fs.mkdirSync(path.join(shallow, 'private'));
  fs.writeFileSync(path.join(shallow, 'private/public-denylist.txt'), LIST);
  const tip = r.git('rev-parse', 'HEAD');
  blocked(r.hook('pre-push', `HEAD ${tip} refs/heads/main ${ZERO}\n`, shallow), /git fetch --unshallow/);
});

test('pre-push reads multiple ref updates and allows deletions and HEAD sources', t => {
  const r = repo(t);
  const base = r.git('rev-parse', 'HEAD');
  ok(r.hook('pre-push', `(delete) ${ZERO} refs/heads/old ${base}\n`));
  ok(r.hook('pre-push', `HEAD ${base} refs/heads/main ${ZERO}\n`));
  r.stage('leak.txt', 'Zorblat\n');
  const bad = r.commit(false);
  blocked(r.hook('pre-push', `refs/heads/good ${base} refs/heads/good ${ZERO}\nrefs/heads/bad ${bad} refs/heads/bad ${base}\n`), /deny-list term/);
});

test('missing or unreadable deny list fails closed in all hooks', t => {
  const r = repo(t);
  const list = path.join(r.root, 'private/public-denylist.txt');
  r.write('message.txt', 'safe message\n');
  fs.unlinkSync(list);
  blocked(r.hook('pre-commit'), /restore your local deny list/);
  blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /restore your local deny list/);
  blocked(r.push(), /restore your local deny list/);
  fs.mkdirSync(list);
  blocked(r.hook('pre-commit'), /restore your local deny list/);
  blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /restore your local deny list/);
  blocked(r.push(), /restore your local deny list/);
});

test('commit-msg checks full messages, case and word boundaries at commit time', t => {
  const r = repo(t);
  r.stage('public.txt', 'safe\n');
  blocked(command(r.root, 'git', ['commit', '-m', 'public subject', '-m', 'AMBER noodle']), /"commit message":3: deny-list term/);
  ok(command(r.root, 'git', ['commit', '-m', 'preZorblatpost', '-m', 'public body']));
  ok(r.push());
  r.write('nested/message with spaces.txt', 'subject\n\nzOrBlAt\n');
  blocked(r.hook('commit-msg', '', path.join(r.root, 'nested'), ['message with spaces.txt']), /"commit message":3: deny-list term/);
});

test('pre-push catches a full-message violation in an intermediate --no-verify commit', t => {
  const r = repo(t);
  const base = r.git('rev-parse', 'HEAD');
  r.stage('public.txt', 'safe\n');
  r.git('commit', '--no-verify', '-m', 'public subject', '-m', 'zOrBlAt');
  const bad = r.git('rev-parse', 'HEAD');
  r.stage('later.txt', 'safe\n');
  const tip = r.commit();
  const result = r.push(tip, base);
  blocked(result, /"commit message":3: deny-list term/);
  assert.ok(result.stderr.includes(bad.slice(0, 12)));
});

for (const change of ['added', 'renamed', 'copied']) {
  test(`deny-list term in ${change} path is blocked by both file-checking hooks`, t => {
    const r = repo(t);
    r.stage('source.txt', 'public text\n');
    const base = r.commit();
    const name = 'zOrBlAt notes.txt';
    if (change === 'renamed') r.git('mv', 'source.txt', name);
    else r.stage(name, change === 'copied' ? fs.readFileSync(path.join(r.root, 'source.txt')) : 'safe\n');
    const result = r.hook('pre-commit');
    blocked(result, /"zOrBlAt notes.txt":1: deny-list term/);
    const tip = r.commit(false);
    blocked(r.push(tip, base), /"zOrBlAt notes.txt":1: deny-list term/);
  });
}

test('longer words in added paths pass', t => {
  const r = repo(t);
  r.stage('preZorblatpost.txt', 'safe\n');
  r.commit();
  ok(r.push());
});

for (const name of ['data', 'evaluation']) {
  test(`exact reserved root name is blocked: ${name}`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    r.stage(name, 'safe\n');
    blocked(r.hook('pre-commit'), /private\/runtime path/);
    const tip = r.commit(false);
    blocked(r.push(tip, base), /private\/runtime path/);
  });
}

test('a symlink named private is blocked even when the main deny list is readable', t => {
  const r = repo(t);
  const base = r.git('rev-parse', 'HEAD');
  fs.renameSync(path.join(r.root, 'private'), path.join(r.root, 'local-secret-store'));
  fs.symlinkSync('local-secret-store', path.join(r.root, 'private'));
  r.git('add', '-f', 'private');
  blocked(r.hook('pre-commit'), /"private": private\/runtime path/);
  const tip = r.commit(false);
  blocked(r.push(tip, base), /"private": private\/runtime path/);
});

test('linked worktree hooks use only the main working tree deny list', t => {
  const r = repo(t);
  const linked = `${r.root}-linked`;
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  r.git('worktree', 'add', '--detach', linked, 'HEAD');
  fs.cpSync(path.join(SOURCE, '.githooks'), path.join(linked, '.githooks'), { recursive: true });
  assert.equal(fs.existsSync(path.join(linked, 'private')), false);
  fs.writeFileSync(path.join(linked, 'public.txt'), 'safe\n');
  ok(command(linked, 'git', ['add', 'public.txt']));
  ok(r.hook('pre-commit', '', linked));
  ok(command(linked, 'git', ['commit', '-m', 'safe message']));
  const tip = command(linked, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  ok(r.hook('pre-push', `HEAD ${tip} refs/heads/main ${ZERO}\n`, linked));
  fs.writeFileSync(path.join(linked, 'public.txt'), 'zOrBlAt\n');
  ok(command(linked, 'git', ['add', 'public.txt']));
  blocked(r.hook('pre-commit', '', linked), /deny-list term/);
  fs.writeFileSync(path.join(linked, 'message.txt'), 'Amber Noodle\n');
  blocked(r.hook('commit-msg', '', linked, ['message.txt']), /deny-list term/);
  // A local decoy list must not replace a missing main-tree list.
  fs.mkdirSync(path.join(linked, 'private'));
  fs.writeFileSync(path.join(linked, 'private/public-denylist.txt'), '# empty decoy\n');
  fs.unlinkSync(path.join(r.root, 'private/public-denylist.txt'));
  blocked(r.hook('pre-commit', '', linked), /main working tree.*restore your local deny list/);
  blocked(r.hook('commit-msg', '', linked, ['message.txt']), /restore your local deny list/);
  blocked(r.hook('pre-push', `HEAD ${tip} refs/heads/main ${ZERO}\n`, linked), /restore your local deny list/);
});

test('annotated tag messages are checked even when their commit is already remote', t => {
  const r = repo(t);
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'HEAD'));
  r.git('tag', '-a', 'bad-tag', '-m', 'public subject', '-m', 'AMBER noodle');
  const tag = r.git('rev-parse', 'bad-tag');
  const result = r.hook('pre-push', `refs/tags/bad-tag ${tag} refs/tags/bad-tag ${ZERO}\n`);
  blocked(result, /"tag message":3: deny-list term/);
  assert.ok(result.stderr.includes(`tag ${tag.slice(0, 12)}`));
});

test('nested annotated tags check inner messages too', t => {
  const r = repo(t);
  r.git('tag', '-a', 'inner', '-m', 'zOrBlAt');
  r.git('-c', 'advice.nestedTag=false', 'tag', '-a', 'outer', 'inner', '-m', 'public outer');
  const tag = r.git('rev-parse', 'outer');
  blocked(r.hook('pre-push', `refs/tags/outer ${tag} refs/tags/outer ${ZERO}\n`), /"tag message":1: deny-list term/);
});

test('clean annotated tags pass and still inspect the commits they point to', t => {
  const r = repo(t);
  r.git('tag', '-a', 'clean', '-m', 'preZorblatpost');
  const clean = r.git('rev-parse', 'clean');
  ok(r.hook('pre-push', `refs/tags/clean ${clean} refs/tags/clean ${ZERO}\n`));
  r.stage('public.txt', 'safe\n');
  r.git('commit', '--no-verify', '-m', 'public subject', '-m', 'Zorblat');
  const bad = r.git('rev-parse', 'HEAD');
  r.git('tag', '-a', 'clean-message', '-m', 'public message');
  const tag = r.git('rev-parse', 'clean-message');
  const result = r.hook('pre-push', `refs/tags/clean-message ${tag} refs/tags/clean-message ${ZERO}\n`);
  blocked(result, /"commit message":3: deny-list term/);
  assert.ok(result.stderr.includes(bad.slice(0, 12)));
});

test('new refs never exclude history from an unrelated remote or a prefix lookalike', t => {
  const r = repo(t);
  r.stage('public.txt', 'safe\n');
  const bad = r.commit(false, { GIT_AUTHOR_EMAIL: 'fixture@example.invalid' });
  r.git('update-ref', 'refs/remotes/other/main', bad);
  r.git('update-ref', 'refs/remotes/origin-extra/main', bad);
  blocked(r.push(), /author\/committer email must be/);
  // Selecting the actual destination namespace excludes its existing history.
  ok(r.push(undefined, ZERO, 'other'));
  // An unnamed/URL destination has no trusted tracking namespace.
  blocked(r.hook('pre-push', `HEAD ${bad} refs/heads/main ${ZERO}\n`, r.root, ['file:///unused']), /author\/committer email must be/);
});

test('install from an old linked worktree uses main hooks without local hook files', t => {
  const r = repo(t);
  r.stage('later.txt', 'safe\n');
  r.commit();
  const linked = `${r.root}-old revision`;
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  r.git('worktree', 'add', '--detach', linked, 'HEAD~1');
  const prototype = path.join(linked, 'prototype');
  fs.mkdirSync(prototype);
  fs.copyFileSync(path.join(SOURCE, 'prototype/package.json'), path.join(prototype, 'package.json'));
  ok(command(prototype, 'npm', ['run', 'guard:install']));
  assert.equal(command(linked, 'git', ['config', '--get', 'core.hooksPath']).stdout.trim(), path.join(r.root, '.githooks'));
  assert.equal(fs.existsSync(path.join(linked, '.githooks')), false);
  fs.writeFileSync(path.join(linked, 'public.txt'), 'safe\n');
  ok(command(linked, 'git', ['add', 'public.txt']));
  ok(command(linked, 'git', ['commit', '-m', 'public change']));
  fs.writeFileSync(path.join(linked, 'public.txt'), 'Zorblat\n');
  ok(command(linked, 'git', ['add', 'public.txt']));
  blocked(command(linked, 'git', ['commit', '-m', 'public change']), /deny-list term/);
  fs.writeFileSync(path.join(linked, 'public.txt'), 'safe again\n');
  ok(command(linked, 'git', ['add', 'public.txt']));
  blocked(command(linked, 'git', ['commit', '-m', 'Zorblat']), /"commit message"/);
  ok(command(linked, 'git', ['commit', '--no-verify', '-m', 'Zorblat']));
  const tip = command(linked, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  blocked(r.hook('pre-push', `HEAD ${tip} refs/heads/main ${ZERO}\n`, linked), /"commit message"/);
});

test('pre-commit checks effective author and committer names', t => {
  const r = repo(t);
  for (const identity of ['AUTHOR', 'COMMITTER']) {
    blocked(command(r.root, path.join(r.root, '.githooks/pre-commit'), [], {
      env: { ...ENV, [`GIT_${identity}_NAME`]: 'zOrBlAt' },
    }), new RegExp(`"${identity.toLowerCase()} name":1: deny-list term`));
  }
  r.git('config', 'user.name', 'Amber Noodle');
  blocked(r.hook('pre-commit'), /"author name":1: deny-list term/);
});

for (const identity of ['AUTHOR', 'COMMITTER']) {
  test(`pre-push checks ${identity.toLowerCase()} name in skipped-hook commits`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    r.stage('public.txt', 'safe\n');
    const tip = r.commit(false, { [`GIT_${identity}_NAME`]: 'zOrBlAt' });
    const result = r.push(tip, base);
    blocked(result, new RegExp(`"${identity.toLowerCase()} name":1: deny-list term`));
    assert.ok(result.stderr.includes('"Zorblat"')); // Keep the local matched-term diagnostic.
  });
}

test('longer words in identity names pass', t => {
  const r = repo(t);
  r.stage('public.txt', 'safe\n');
  r.commit(true, { GIT_AUTHOR_NAME: 'preZorblatpost', GIT_COMMITTER_NAME: 'preZorblatpost' });
  ok(r.push());
});

for (const [name, email, pattern] of [
  ['zOrBlAt', EMAIL, /"tagger name":1: deny-list term/],
  ['Guard Fixture', 'zorblat@example.invalid', /"tagger email":1: deny-list term/],
  ['Guard Fixture', 'fixture@example.invalid', /tagger email must be/],
]) {
  test(`annotated tagger identity is checked: ${pattern.source}`, t => {
    const r = repo(t);
    r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'HEAD'));
    ok(command(r.root, 'git', ['tag', '-a', 'public-tag', '-m', 'safe'], {
      env: { ...ENV, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    }));
    const tag = r.git('rev-parse', 'public-tag');
    blocked(r.hook('pre-push', `refs/tags/public-tag ${tag} refs/tags/public-tag ${ZERO}\n`), pattern);
  });
}

test('destination ref names are checked even for deletions', t => {
  const r = repo(t);
  const tip = r.git('rev-parse', 'HEAD');
  for (const [local, old] of [[tip, ZERO], [ZERO, tip]]) {
    blocked(r.hook('pre-push', `HEAD ${local} refs/heads/zOrBlAt ${old}\n`), /"destination ref":1: deny-list term/);
  }
  ok(r.hook('pre-push', `HEAD ${tip} refs/heads/preZorblatpost ${ZERO}\n`));
});

test('annotated tag header name is checked independently of destination ref', t => {
  const r = repo(t);
  r.git('tag', '-a', 'zOrBlAt', '-m', 'safe');
  const tag = r.git('rev-parse', 'zOrBlAt');
  blocked(r.hook('pre-push', `refs/tags/zOrBlAt ${tag} refs/tags/public-alias ${ZERO}\n`), /"annotated tag name":1: deny-list term/);
});

for (const file of ['.env', '.env.local', 'nested/.env', 'nested/deep/.env.production', '.env.example.local']) {
  test(`environment file blocked in index and history: ${file}`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    r.stage(file, 'PUBLIC_PLACEHOLDER=value\n');
    blocked(r.hook('pre-commit'), /environment file/);
    const tip = r.commit(false);
    blocked(r.push(tip, base), /environment file/);
  });
}

test('only exact .env.example is exempt, at any depth', t => {
  const r = repo(t);
  r.stage('.env.example', 'PUBLIC_PLACEHOLDER=value\n');
  r.stage('nested/.env.example', 'PUBLIC_PLACEHOLDER=value\n');
  r.commit();
  ok(r.push());
});

function encoded(text, encoding) {
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  const bytes = Buffer.from(text, 'utf16le');
  if (encoding === 'utf16be') bytes.swap16();
  return Buffer.concat([Buffer.from(encoding === 'utf16be' ? [0xfe, 0xff] : [0xff, 0xfe]), bytes]);
}

for (const encoding of ['utf16le', 'utf16be', 'utf8-bom']) {
  test(`BOM decoding scans added files, history and message files: ${encoding}`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    const bytes = encoded('public\nzOrBlAt\n', encoding);
    r.stage('encoded.txt', bytes);
    blocked(r.hook('pre-commit'), /"encoded.txt":2: deny-list term/);
    r.write('message.txt', bytes);
    blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /"commit message":2: deny-list term/);
    const tip = r.commit(false);
    blocked(r.push(tip, base), /"encoded.txt":2: deny-list term/);
  });

  test(`decoded diffs preserve added-only semantics and line numbers: ${encoding}`, t => {
    const r = repo(t);
    r.stage('encoded.txt', encoded('public\nZorblat\nold\n', encoding));
    const base = r.commit(false);
    r.stage('encoded.txt', encoded('public\nold\nnew safe\n', encoding));
    ok(r.hook('pre-commit')); // Deleted term.
    const removed = r.commit();
    ok(r.push(removed, base));
    r.stage('encoded.txt', encoded('public\nold\nnew safe\nAMBER noodle\n', encoding));
    blocked(r.hook('pre-commit'), /"encoded.txt":4: deny-list term/);
    // An unchanged term does not become an added line just because encoding changes.
    r.git('reset', '--hard', base);
    r.stage('encoded.txt', encoded('public\nZorblat\nold\nnew safe\n', 'utf8-bom'));
    ok(r.hook('pre-commit'));
  });

  test(`raw commit and tag message BOMs are decoded: ${encoding}`, t => {
    const r = repo(t);
    const base = r.git('rev-parse', 'HEAD');
    const tree = r.git('rev-parse', 'HEAD^{tree}');
    const ident = r.git('var', 'GIT_COMMITTER_IDENT');
    // UTF-16 messages contain NUL bytes and fail fsck; raw objects also exercise
    // defensive decoding if such an object is encountered during inspection.
    const commit = command(r.root, 'git', ['hash-object', '--literally', '-w', '-t', 'commit', '--stdin'], {
      input: Buffer.concat([Buffer.from(`tree ${tree}\nparent ${base}\nauthor ${ident}\ncommitter ${ident}\n\n`), encoded('public\nzOrBlAt\n', encoding)]),
    });
    ok(commit);
    blocked(r.push(commit.stdout.trim(), base), /"commit message":2: deny-list term/);
    const tag = command(r.root, 'git', ['hash-object', '--literally', '-w', '-t', 'tag', '--stdin'], {
      input: Buffer.concat([Buffer.from(`object ${base}\ntype commit\ntag public-tag\ntagger ${ident}\n\n`), encoded('public\nAMBER noodle\n', encoding)]),
    });
    ok(tag);
    blocked(r.hook('pre-push', `refs/tags/public-tag ${tag.stdout.trim()} refs/tags/public-tag ${ZERO}\n`), /"tag message":2: deny-list term/);
  });
}

for (const contents of ['', ' \n# comments only\n  # another comment\n']) {
  test(`empty/comments-only deny list fails closed: ${JSON.stringify(contents)}`, t => {
    const r = repo(t);
    r.write('private/public-denylist.txt', contents);
    r.write('message.txt', 'safe\n');
    blocked(r.hook('pre-commit'), /Empty deny list/);
    blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /Empty deny list/);
    blocked(r.push(), /Empty deny list/);
  });
}

test('commit-msg ignores default comments and everything from scissors onward', t => {
  const r = repo(t);
  r.write('message.txt', 'public subject\n# zOrBlAt\n\npublic body\n# ------------------------ >8 ------------------------\nAmber Noodle\n');
  ok(r.hook('commit-msg', '', r.root, ['message.txt']));
  r.write('message.txt', 'public # Zorblat\n');
  blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /deny-list term/);
  r.write('message.txt', ' # Zorblat\n');
  blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /deny-list term/);
  r.write('message.txt', 'Zorblat\n# ------------------------ >8 ------------------------\npublic\n');
  blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /deny-list term/);
});

test('commit-msg honors custom core.commentChar and pre-push still scans stored comments', t => {
  const r = repo(t);
  r.git('config', 'core.commentChar', ';');
  r.write('message.txt', 'public subject\n; zOrBlAt\n\n; ------------------------ >8 ------------------------\nAmber Noodle\n');
  ok(r.hook('commit-msg', '', r.root, ['message.txt']));
  r.write('message.txt', 'public subject\n# ------------------------ >8 ------------------------\nAmber Noodle\n');
  ok(r.hook('commit-msg', '', r.root, ['message.txt']));
  r.write('message.txt', '# zOrBlAt\n');
  blocked(r.hook('commit-msg', '', r.root, ['message.txt']), /deny-list term/);
  r.write('message.txt', 'public subject\n; zOrBlAt\n');
  r.stage('public.txt', 'safe\n');
  r.git('commit', '--cleanup=strip', '-F', 'message.txt');
  ok(r.push());
  r.stage('later.txt', 'safe\n');
  r.git('commit', '--no-verify', '--cleanup=verbatim', '-F', 'message.txt');
  blocked(r.push(), /"commit message":2: deny-list term/);
});

test('missing history and malformed push input fail closed', t => {
  const r = repo(t);
  blocked(r.push(undefined, '1'.repeat(40)), /fetch missing history/);
  blocked(r.hook('pre-push', 'invalid input\n'), /Cannot parse push updates/);
});

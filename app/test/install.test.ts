import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'hearalong-install-'));
const release = join(directory, 'release');
const asset = 'HearAlong-mac-arm64.zip';
const installer = join(repo, 'install.sh');
const real = process.env.HEARALONG_INSTALL_TEST_REAL === '1';
const system = (command: string) => execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim();
function checksum(folder: string) {
  writeFileSync(join(folder, `${asset}.sha256`), `${createHash('sha256').update(readFileSync(join(folder, asset))).digest('hex')}  ${asset}\n`);
}
before(() => {
  mkdirSync(release);
  if (real) {
    assert.ok(process.env.HEARALONG_INSTALL_TEST_RELEASE);
    cpSync(join(process.env.HEARALONG_INSTALL_TEST_RELEASE!, asset), join(release, asset));
  } else {
    const source = join(directory, 'source');
    mkdirSync(join(source, 'HearAlong.app/Contents/Resources/bin'), { recursive: true });
    // Plain logic fixture only. The real-archive mode executes bundled Node/Koffi's actual atomic exchange.
    writeFileSync(join(source, 'HearAlong.app/Contents/Resources/bin/node'), `#!/bin/sh
set -eu
[ "\${TEST_SWAP_FAIL:-}" != 1 ] || exit 93
if [ "$2" = --install ]; then
  case "\${TEST_APPEAR_DURING_MOVE:-}" in
    file) printf fictional-foreign > "$4" ;;
    directory) "${system('mkdir')}" "$4" ;;
    symlink) "${system('ln')}" -s "$TEST_ROOT/outside" "$4" ;;
  esac
  if [ "\${TEST_INTERRUPT_MOVE:-}" = 1 ]; then /bin/kill -INT "$PPID"; exit 97; fi
  [ ! -e "$4" ] && [ ! -L "$4" ] || exit 94
  exec "${system('mv')}" "$3" "$4"
fi
case "$0" in "$TEST_APP"/*)
  if [ "\${TEST_CLEANUP_INTERRUPT:-}" = 1 ]; then /bin/kill -INT "$PPID"; echo rollback-interrupt >> "$CALLS"; fi ;;
esac
"${system('mv')}" "$2" "$2.swap"
"${system('mv')}" "$3" "$2"
"${system('mv')}" "$2.swap" "$3"
`, { mode: 0o755 });
    writeFileSync(join(source, 'HearAlong.app/Contents/Info.plist'), 'fictional bundle');
    writeFileSync(join(source, 'HearAlong.app/Contents/Resources/install.sh'), readFileSync(installer));
    execFileSync('zip', ['-qr', join(release, asset), 'HearAlong.app'], { cwd: source });
  }
  checksum(release);
});
after(() => rmSync(directory, { recursive: true, force: true }));
function fixture() {
  const root = mkdtempSync(join(directory, 'case-')), home = join(root, 'fictional home'), bin = join(root, 'bin'), log = join(root, 'calls');
  const appRoot = join(home, 'Library/Application Support/HearAlong'), app = join(home, 'Applications/HearAlong.app');
  const data = join(appRoot, 'data'), helper = join(home, 'Applications/HearAlong Helper.app');
  mkdirSync(bin); mkdirSync(home); writeFileSync(log, '');
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  for (const name of ['mkdir', 'rm', 'rmdir', 'readlink', 'awk', 'shasum', 'mktemp', 'zipinfo', 'grep']) symlinkSync(system(name), join(bin, name));
  stub('uname', 'case "$1" in -s) echo "${TEST_OS:-Darwin}" ;; -m) echo "${TEST_ARCH:-arm64}" ;; esac');
  stub('sw_vers', 'echo "${TEST_MACOS:-26.0}"');
  stub('pgrep', 'echo pgrep >> "$CALLS"; [ "${TEST_RUNNING:-}" = app ] || [ "${TEST_RUNNING:-}" = helper ]');
  stub('nc', 'echo port-probe >> "$CALLS"; [ "${TEST_RUNNING:-}" = server ] || [ -f "$TEST_ROOT/started" ]');
  stub('curl', `echo download >> "$CALLS"
case "$*" in *file://*) exec "${system('curl')}" "$@" ;; *) echo 'Internet curl refused by installer fixture' >&2; exit 90 ;; esac`);
  stub('ditto', `echo unpack >> "$CALLS"
[ "\${TEST_UNPACK_FAIL:-}" != 1 ]
${real ? `exec "${system('ditto')}" "$@"` : `exec "${system('unzip')}" -q "$3" -d "$4"`}`);
  stub('codesign', `echo codesign >> "$CALLS"
[ "\${TEST_SIGN_FAIL:-}" != 1 ]
case "$*" in *unpacked*) ;; *)
  if [ "\${TEST_CLEANUP_INTERRUPT:-}" = 1 ]; then /bin/kill -INT "$PPID"; exit 1; fi
  [ "\${TEST_FINAL_SIGN_FAIL:-}" != 1 ] ;;
esac
${real ? `exec "${system('codesign')}" "$@"` : ':'}`);
  stub('plutil', `if [ "\${TEST_BAD_ID:-}" = 1 ]; then echo invalid.fixture; exit; fi
${real ? `exec "${system('plutil')}" "$@"` : 'echo io.github.zihao-qi.hearalong'}`);
  stub('xattr', `if [ "\${TEST_QUARANTINE:-}" = 1 ]; then echo com.apple.quarantine; exit; fi
${real ? `exec "${system('xattr')}" "$@"` : ':'}`);
  stub('open', 'echo open >> "$CALLS"');
  if (process.platform === 'darwin') symlinkSync(system('stat'), join(bin, 'stat'));
  else stub('stat', `exec "${system('stat')}" -c %i "$3"`);
  stub('mv', `case "$1" in */unpacked/HearAlong.app) [ "\${TEST_SWAP_FAIL:-}" != 1 ] ;; esac
exec "${system('mv')}" "$@"`);
  const env = { ...process.env, PATH: bin, TMPDIR: root, CALLS: log, TEST_ROOT: root,
    TEST_APP: app, HEARALONG_TEST_MODE: '1', HEARALONG_TEST_HOME: home, HEARALONG_RELEASE_URL: pathToFileURL(release).href };
  const run = (extra: Record<string, string> = {}, args: string[] = [], input?: string) => {
    const result = spawnSync('/bin/sh', input === undefined ? [installer, ...args] : ['-s', '--', ...args], {
      env: { ...env, ...extra }, input, encoding: 'utf8', timeout: real ? 120_000 : 30_000,
    });
    assert.ifError(result.error);
    return { ...result, output: result.stdout + result.stderr };
  };
  const ok = (extra: Record<string, string> = {}) => { const result = run(extra); assert.equal(result.status, 0, result.output); return result; };
  return { root, home, bin, appRoot, app, data, helper, run, ok, calls: () => readFileSync(log, 'utf8') };
}
function legacy(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.appRoot, '.app-abc123/app'), { recursive: true });
  symlinkSync('.app-abc123/app', join(f.appRoot, 'app'));
  mkdirSync(f.helper, { recursive: true }); writeFileSync(join(f.helper, 'fictional'), 'old helper');
  writeFileSync(join(f.appRoot, 'helper.json'), '{"fictional":"v0.2.0"}');
  mkdirSync(f.data); writeFileSync(join(f.data, 'meeting.txt'), 'fictional meeting\0unchanged\n');
}
test('fresh streamed install, rerun and uninstall use only the test home and keep meetings', () => {
  const f = fixture();
  const result = f.run({}, [], readFileSync(installer, 'utf8'));
  assert.equal(result.status, 0, result.output);
  assert.ok(existsSync(join(f.app, 'Contents/Resources/install.sh')));
  assert.ok(!existsSync(f.data), 'installer never creates or changes data');
  mkdirSync(f.data); writeFileSync(join(f.data, 'meeting.txt'), 'fictional meeting');
  mkdirSync(join(f.appRoot, 'Electron')); writeFileSync(join(f.appRoot, 'Electron/profile'), 'fictional profile');
  f.ok();
  const removed = f.run({}, ['--uninstall']);
  assert.equal(removed.status, 0, removed.output);
  assert.ok(!existsSync(f.app)); assert.ok(!existsSync(join(f.appRoot, 'Electron')));
  assert.equal(readFileSync(join(f.data, 'meeting.txt'), 'utf8'), 'fictional meeting');
  assert.match(removed.output, /meetings are kept/);
  assert.doesNotMatch(result.output, /127\.0\.0\.1|helper|Homebrew|Node|npm|Xcode/i);
  assert.match(f.calls(), /open/);
});
test('v0.2.0 migration removes only owned old layout; data survives byte-identical', () => {
  const f = fixture(); legacy(f);
  const before = readFileSync(join(f.data, 'meeting.txt'));
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'keep');
  symlinkSync(outside, join(f.appRoot, '.app-def456'));
  mkdirSync(join(f.appRoot, '.app-not-owned'));
  f.ok();
  for (const path of ['app', '.app-abc123', 'helper.json']) assert.ok(!existsSync(join(f.appRoot, path)), path);
  assert.ok(!existsSync(f.helper));
  assert.deepEqual(readFileSync(join(f.data, 'meeting.txt')), before);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  assert.ok(lstatSync(join(f.appRoot, '.app-def456')).isSymbolicLink());
  assert.ok(existsSync(join(f.appRoot, '.app-not-owned')));
});
for (const failure of ['TEST_SIGN_FAIL', 'TEST_FINAL_SIGN_FAIL', 'TEST_SWAP_FAIL', 'TEST_UNPACK_FAIL']) {
  test(`${failure}: failed upgrade restores previous app and leaves legacy data untouched`, () => {
    const f = fixture(); f.ok(); legacy(f);
    writeFileSync(join(f.app, 'previous-marker'), 'fictional previous bundle');
    const result = f.run({ [failure]: '1' });
    assert.notEqual(result.status, 0, result.output);
    assert.equal(readFileSync(join(f.app, 'previous-marker'), 'utf8'), 'fictional previous bundle');
    assert.ok(existsSync(f.helper)); assert.equal(readlinkSync(join(f.appRoot, 'app')), '.app-abc123/app');
    assert.equal(readFileSync(join(f.data, 'meeting.txt'), 'utf8'), 'fictional meeting\0unchanged\n');
    assert.ok(!existsSync(join(f.appRoot, '.install-lock')));
  });
}
for (const [state, message] of [['TEST_BAD_ID', 'wrong bundle identifier'], ['TEST_QUARANTINE', 'quarantined']]) {
  test(`${state} release is refused before activation`, () => {
    const f = fixture();
    let extra = { [state]: '1' };
    if (real && state === 'TEST_BAD_ID') {
      const bad = join(f.root, 'wrong-id'), bundle = join(bad, 'HearAlong.app');
      mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
      cpSync('/usr/bin/true', join(bundle, 'Contents/MacOS/Fictional'));
      writeFileSync(join(bundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>invalid.fixture</string><key>CFBundleExecutable</key><string>Fictional</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, join(bad, asset)]); checksum(bad);
      extra = { HEARALONG_RELEASE_URL: pathToFileURL(bad).href };
    }
    const result = f.run(extra);
    assert.notEqual(result.status, 0); assert.match(result.output, new RegExp(message)); assert.ok(!existsSync(f.app));
  });
}
test('bad hash is refused before extraction; uppercase valid hash is accepted', () => {
  const f = fixture(), broken = join(f.root, 'broken'); cpSync(release, broken, { recursive: true });
  const hashfile = join(broken, `${asset}.sha256`), original = readFileSync(hashfile, 'utf8');
  writeFileSync(hashfile, `${'0'.repeat(64)}  ignored-name\n`);
  const result = f.run({ HEARALONG_RELEASE_URL: pathToFileURL(broken).href });
  assert.notEqual(result.status, 0); assert.match(result.output, /checksum mismatch/);
  assert.doesNotMatch(f.calls(), /unpack|codesign|open/); assert.ok(!existsSync(f.data));
  writeFileSync(hashfile, original.toUpperCase()); f.ok({ HEARALONG_RELEASE_URL: pathToFileURL(broken).href });
});
for (const running of ['app', 'helper', 'server']) {
  test(`running ${running} refuses install and uninstall without stopping anything`, () => {
    const f = fixture();
    for (const args of [[], ['--uninstall']]) {
      const result = f.run({ TEST_RUNNING: running }, args);
      assert.notEqual(result.status, 0); assert.match(result.output, /Nothing was stopped/); assert.ok(!existsSync(f.appRoot));
    }
    assert.doesNotMatch(f.calls(), /download|unpack|open/);
  });
}
test('live server.lock PID without a newline refuses fresh install, upgrade and uninstall; data stays untouched', () => {
  const f = fixture();
  mkdirSync(f.data, { recursive: true });
  const lock = join(f.data, 'server.lock'), marker = join(f.data, 'meeting.txt');
  const pid = String(process.pid); // Only probe our own live test process, never signal it.
  writeFileSync(marker, 'fictional meeting'); writeFileSync(lock, pid);
  let lockInode = lstatSync(lock).ino;
  const refused = () => {
    const calls = f.calls().length;
    for (const args of [[], ['--uninstall']]) {
      const result = f.run({}, args);
      assert.notEqual(result.status, 0); assert.match(result.output, /Nothing was stopped/);
      assert.equal(readFileSync(lock, 'utf8'), pid); assert.equal(lstatSync(lock).ino, lockInode);
      assert.equal(readFileSync(marker, 'utf8'), 'fictional meeting');
    }
    assert.doesNotMatch(f.calls().slice(calls), /download|unpack|open/);
  };
  refused(); assert.ok(!existsSync(f.app));
  rmSync(lock); // Fixture setup only; the installer never removes this file.
  f.ok(); writeFileSync(lock, pid);
  lockInode = lstatSync(lock).ino;
  const appInode = lstatSync(f.app).ino;
  refused(); assert.equal(lstatSync(f.app).ino, appInode);
});
test('unmanaged app appearing during download is preserved before activation', () => {
  for (const kind of ['file', 'directory', 'symlink']) {
    const f = fixture();
    const create = kind === 'file' ? 'printf fictional-foreign > "$TEST_APP"'
      : kind === 'directory' ? `"${system('mkdir')}" "$TEST_APP"`
        : `"${system('ln')}" -s "$TEST_ROOT/outside" "$TEST_APP"`;
    writeFileSync(join(f.bin, 'xattr'), `#!/bin/sh\n${create}\n`);
    writeFileSync(join(f.bin, 'plutil'), `#!/bin/sh\ncase "$*" in *"$TEST_APP/Contents/Info.plist"*) echo invalid.fixture ;; *) echo io.github.zihao-qi.hearalong ;; esac\n`);
    const result = f.run();
    assert.notEqual(result.status, 0); assert.match(result.output, /unmanaged HearAlong.app/);
    const info = lstatSync(f.app);
    assert.equal(info.isSymbolicLink(), kind === 'symlink'); assert.equal(info.isDirectory(), kind === 'directory');
    if (kind === 'file') assert.equal(readFileSync(f.app, 'utf8'), 'fictional-foreign');
    if (kind === 'directory') assert.deepEqual(readdirSync(f.app), []);
    assert.ok(!existsSync(join(f.appRoot, '.install-lock')));
  }
});
test('fresh promotion refuses late destinations and interrupted moves never delete a foreign item', { skip: real }, () => {
  for (const kind of ['file', 'directory', 'symlink']) for (const interrupted of ['0', '1']) {
    const f = fixture();
    const result = f.run({ TEST_APPEAR_DURING_MOVE: kind, TEST_INTERRUPT_MOVE: interrupted });
    assert.notEqual(result.status, 0);
    assert.ok(lstatSync(f.app));
    if (kind === 'file') assert.equal(readFileSync(f.app, 'utf8'), 'fictional-foreign');
    if (kind === 'directory') assert.deepEqual(readdirSync(f.app), [], 'no nested bundle');
    if (kind === 'symlink') assert.equal(readlinkSync(f.app), join(f.root, 'outside'));
    assert.ok(!existsSync(join(f.appRoot, '.install-lock')));
  }
});
test('fresh rollback does not delete a foreign replacement of the promoted bundle', () => {
  const f = fixture();
  writeFileSync(join(f.bin, 'codesign'), `#!/bin/sh\ncase "$*" in *unpacked*) exit 0 ;; esac\n"${system('mv')}" "$TEST_APP" "$TEST_ROOT/saved-app"\nprintf fictional-foreign > "$TEST_APP"\nexit 1\n`);
  const result = f.run(); assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.app, 'utf8'), 'fictional-foreign');
  assert.ok(!existsSync(join(f.appRoot, '.install-lock')));
});
test('second Ctrl-C during cleanup cannot interrupt rollback or leave the lock', { skip: real }, () => {
  const f = fixture(); f.ok();
  writeFileSync(join(f.app, 'previous-marker'), 'fictional old bundle');
  const inode = lstatSync(f.app).ino;
  const result = f.run({ TEST_CLEANUP_INTERRUPT: '1' });
  assert.notEqual(result.status, 0); assert.match(f.calls(), /rollback-interrupt/);
  assert.equal(lstatSync(f.app).ino, inode);
  assert.equal(readFileSync(join(f.app, 'previous-marker'), 'utf8'), 'fictional old bundle');
  assert.ok(!existsSync(join(f.appRoot, '.install-lock')));
});
test('listener appearing during unpack refuses activation', () => {
  const f = fixture();
  writeFileSync(join(f.bin, 'xattr'), '#!/bin/sh\n: > "$TEST_ROOT/started"\n');
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.output, /Please quit/); assert.ok(!existsSync(f.app));
});
test('Intel, older macOS, other OS and malformed arguments change nothing', () => {
  const f = fixture();
  for (const [key, value] of [['TEST_ARCH', 'x86_64'], ['TEST_MACOS', '25.6'], ['TEST_OS', 'Linux']]) {
    const result = f.run({ [key]: value }); assert.notEqual(result.status, 0); assert.ok(!existsSync(f.appRoot));
  }
  assert.match(f.run({ TEST_ARCH: 'x86_64' }).output, /Intel Macs are not supported yet/);
  assert.notEqual(f.run({}, ['--unknown']).status, 0);
  assert.equal(f.calls(), '');
});
test('install lock blocks both operations', () => {
  const f = fixture(); mkdirSync(join(f.appRoot, '.install-lock'), { recursive: true });
  for (const args of [[], ['--uninstall']]) assert.match(f.run({}, args).output, /Another HearAlong install/);
  assert.doesNotMatch(f.calls(), /download/);
});
test('arbitrary old app symlink and symlinked version are refused, not traversed', () => {
  for (const target of ['/fictional/elsewhere', '.app-abc123/app']) {
    const f = fixture(); mkdirSync(f.appRoot, { recursive: true }); symlinkSync(target, join(f.appRoot, 'app'));
    if (target.startsWith('.app')) symlinkSync(f.root, join(f.appRoot, '.app-abc123'));
    assert.match(f.run().output, /Unrecognized installation/); assert.equal(readlinkSync(join(f.appRoot, 'app')), target);
  }
});
test('uninstall removes orphaned owned legacy folders even without app symlink', () => {
  const f = fixture(); legacy(f); rmSync(join(f.appRoot, 'app'));
  const result = f.run({}, ['--uninstall']); assert.equal(result.status, 0, result.output);
  assert.ok(!existsSync(join(f.appRoot, '.app-abc123'))); assert.ok(existsSync(join(f.data, 'meeting.txt')));
  assert.equal(f.run({}, ['--uninstall']).status, 0);
});
test('test release override is ignored without test mode; http is always refused', () => {
  const f = fixture();
  // HOME itself is fictional too, so ignoring HEARALONG_TEST_HOME cannot touch the actual user.
  const result = f.run({ HEARALONG_TEST_MODE: '0', HOME: f.home });
  assert.notEqual(result.status, 0); assert.match(result.output, /Internet curl refused/);
  assert.match(f.run({ HEARALONG_RELEASE_URL: 'http://example.invalid' }).output, /Release URL must use https/);
});
test('unexpected archive top-level paths are refused', () => {
  const f = fixture(), bad = join(f.root, 'bad'); mkdirSync(bad); writeFileSync(join(bad, 'unwanted'), 'fictional');
  execFileSync('zip', ['-q', join(bad, asset), 'unwanted'], { cwd: bad }); checksum(bad);
  assert.match(f.run({ HEARALONG_RELEASE_URL: pathToFileURL(bad).href }).output, /Unexpected paths/);
  assert.ok(!existsSync(f.app));
});
test('truncated installer streams execute no commands', () => {
  const f = fixture(), source = readFileSync(installer, 'utf8');
  for (const marker of ['set -eu\n', 'not_running\n', 'trap cleanup EXIT\n', 'curl -fSL "$release/$asset"', 'promoted=1\n', 'open "$BUNDLE"\n']) {
    const start = source.indexOf(marker); assert.ok(start >= 0, marker);
    const result = f.run({}, [], source.slice(0, start + marker.length));
    assert.notEqual(result.status, 0); assert.match(result.stderr, /syntax error|unexpected end/i); assert.equal(f.calls(), '');
    assert.deepEqual(readdirSync(f.home), []);
  }
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'hearalong-install-'));
const release = join(directory, 'release');
const installer = join(repo, 'install.sh');
const realNode = process.execPath;
const system = (command: string) => execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim();

before(() => {
  const source = join(directory, 'source');
  mkdirSync(source);
  mkdirSync(release);
  // Only Git-tracked files enter the fixture. Overlay the two implementation files so uncommitted work is tested too.
  execFileSync('git', ['archive', '--format=tar', '-o', join(directory, 'tracked.tar'), 'HEAD', 'app', 'LICENSE'], { cwd: repo });
  execFileSync('tar', ['-xf', join(directory, 'tracked.tar'), '-C', source]);
  cpSync(join(repo, 'app/scripts/build-app.sh'), join(source, 'app/scripts/build-app.sh'));
  cpSync(installer, join(source, 'install.sh'));
  execFileSync('tar', ['-czf', join(release, 'HearAlong.tar.gz'), '-C', source, 'app', 'install.sh', 'LICENSE']);
  checksum(release);
});
after(() => rmSync(directory, { recursive: true, force: true }));
function checksum(folder: string) {
  const hash = createHash('sha256').update(readFileSync(join(folder, 'HearAlong.tar.gz'))).digest('hex');
  writeFileSync(join(folder, 'HearAlong.tar.gz.sha256'), `${hash}  HearAlong.tar.gz\n`);
}

function fixture() {
  const root = mkdtempSync(join(directory, 'case-'));
  const home = join(root, 'fictional home');
  const bin = join(root, 'bin');
  const log = join(root, 'calls');
  const appRoot = join(home, 'Library/Application Support/HearAlong');
  const app = join(appRoot, 'app');
  const data = join(appRoot, 'data');
  const helper = join(home, 'Applications/HearAlong Helper.app');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home);
  mkdirSync(join(home, 'Applications/Google Chrome.app'), { recursive: true });
  writeFileSync(log, '');
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  for (const name of ['sh', 'cat', 'dirname', 'basename', 'mkdir', 'rm', 'rmdir', 'ln', 'readlink', 'cp', 'awk', 'shasum', 'tar', 'gzip', 'mktemp']) {
    symlinkSync(system(name), join(bin, name));
  }
  stub('uname', 'case "$1" in -s) echo "${TEST_OS:-Darwin}" ;; -m) echo "${TEST_ARCH:-arm64}" ;; esac');
  stub('pgrep', 'echo pgrep >> "$CALLS"; [ "${TEST_RUNNING:-}" = helper ]');
  stub('curl', `case "$*" in
  *http://127.0.0.1:4318/*) echo health >> "$CALLS"; [ "\${TEST_RUNNING:-}" = server ] || [ -f "$TEST_ROOT/started" ]; exit $? ;;
  *file://*) echo download >> "$CALLS"; exec "${system('curl')}" "$@" ;;
  *) echo 'Internet curl refused by installer fixture' >&2; exit 90 ;;
esac`);
  stub('brew', `printf 'brew %s\\n' "$*" >> "$CALLS"
case "$*" in
  'install node@22') : > "$TEST_ROOT/node-installed" ;;
  'install ffmpeg') : > "$TEST_ROOT/ffmpeg-installed" ;;
  '--prefix node@22'|'--prefix ffmpeg') echo "$TEST_ROOT/tools" ;;
  *) exit 91 ;;
esac`);
  stub('node', `if [ "\${TEST_NODE:-}" = missing ] && [ ! -f "$TEST_ROOT/node-installed" ]; then exit 1; fi
if [ "\${TEST_NODE:-}" = old ] && [ ! -f "$TEST_ROOT/node-installed" ] && [ "$1" = -e ]; then
  case "$2" in *process.versions.node*) exit 1 ;; esac
fi
if [ "\${TEST_FAIL_SWAP:-}" = 1 ] && [ "$1" = -e ]; then
  case "$2" in *renameSync*) case "$3" in */.next) exit 92 ;; esac ;; esac
fi
exec "${realNode}" "$@"`);
  stub('npm', `printf 'npm %s\\n' "$*" >> "$CALLS"
[ "$*" = 'ci --ignore-scripts --omit=dev' ]
if [ -n "\${TEST_OLD_CODE:-}" ]; then [ -f "$TEST_OLD_CODE" ]; fi
[ "\${TEST_NPM_FAIL:-}" != 1 ]`);
  for (const name of ['ffmpeg', 'ffprobe']) {
    stub(name, `if [ "\${TEST_FFMPEG:-}" = missing ] && [ ! -f "$TEST_ROOT/ffmpeg-installed" ]; then exit 1; fi
if [ "\${TEST_FFMPEG:-}" = old ] && [ ! -f "$TEST_ROOT/ffmpeg-installed" ]; then echo '${name} version 3.2'; else echo '${name} version 8.0'; fi`);
  }
  mkdirSync(join(root, 'tools/bin'), { recursive: true });
  for (const name of ['node', 'npm', 'ffmpeg', 'ffprobe']) symlinkSync(join(bin, name), join(root, 'tools/bin', name));
  stub('swiftc', `echo swiftc >> "$CALLS"
[ "$HEARALONG_NO_REGISTER" = 1 ]
[ "\${TEST_BUILD_FAIL:-}" != 1 ]
if [ "\${TEST_START_DURING_BUILD:-}" = 1 ]; then : > "$TEST_ROOT/started"; fi
while [ "$1" != -o ]; do shift; done
shift
printf '#!/bin/sh\\nexit 0\\n' > "$1"`);
  for (const name of ['sips', 'iconutil']) stub(name, `echo ${name} >> "$CALLS"`);
  stub('codesign', 'echo codesign >> "$CALLS"; [ "${TEST_SIGN_FAIL:-}" != 1 ]');
  stub('lsregister', 'echo lsregister >> "$CALLS"; exit 94');
  stub('open', 'echo open >> "$CALLS"; [ "$HEARALONG_NO_REGISTER" = 1 ]');
  stub('mv', `if [ "\${TEST_FAIL_HELPER_SWAP:-}" = 1 ] && [ "$2" = "$TEST_HELPER" ]; then
  case "$1" in */previous.app) ;; *) exit 93 ;; esac
fi
exec "${system('mv')}" "$@"`);
  const env = { ...process.env, HOME: home, PATH: bin, TMPDIR: root, CALLS: log, TEST_ROOT: root,
    TEST_HELPER: helper, HEARALONG_CHROME_APP: join(home, 'Applications/Google Chrome.app'),
    HEARALONG_NO_REGISTER: '1', HEARALONG_LSREGISTER: join(bin, 'lsregister'),
    HEARALONG_RELEASE_URL: pathToFileURL(release).href };
  const run = (extra: Record<string, string> = {}, args: string[] = [], input?: string) => {
    assert.equal(env.HEARALONG_NO_REGISTER, '1');
    const result = spawnSync('/bin/sh', input === undefined ? [installer, ...args] : ['-s', '--', ...args], {
      env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /lsregister/);
    return { ...result, output: result.stdout + result.stderr };
  };
  const ok = (extra: Record<string, string> = {}) => {
    const result = run(extra);
    assert.equal(result.status, 0, result.output);
    return result;
  };
  const calls = () => readFileSync(log, 'utf8');
  return { root, home, bin, appRoot, app, data, helper, run, ok, calls };
}

test('installer and builder default to the same system LaunchServices tool (never invoked here)', () => {
  const expected = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  for (const file of [installer, join(repo, 'app/scripts/build-app.sh')]) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/HEARALONG_LSREGISTER:-([^}]+)/.exec(source)?.[1], expected);
  }
});

test('truncated installer streams execute no commands and change no files', () => {
  const source = readFileSync(installer, 'utf8');
  const f = fixture();
  // Fail closed and record every stub, even prerequisite probes, if a partial stream executes anything.
  for (const name of readdirSync(f.bin)) {
    const path = join(f.bin, name);
    if (!lstatSync(path).isSymbolicLink()) {
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$CALLS"\nexit 99\n`);
    }
  }
  const snapshot = (path: string): unknown => {
    const info = lstatSync(path);
    return { inode: info.ino, mode: info.mode, mtime: info.mtimeMs,
      content: info.isSymbolicLink() ? readlinkSync(path) : info.isDirectory()
        ? readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])
        : readFileSync(path).toString('base64') };
  };
  const before = snapshot(f.root);
  const markers = ['set -eu\n', 'not_running\n', 'brew install node@22\n', 'acquire_lock\nstage=',
    'trap cleanup EXIT\n', 'curl -fSL "$release/$asset"', '(cd "$stage/app" && npm ci',
    'activated=1\n', 'open "$HELPER"\n'];
  for (const marker of markers) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, marker);
    const result = f.run({}, [], source.slice(0, start + marker.length));
    assert.notEqual(result.status, 0, marker);
    assert.match(result.stderr, /syntax error|unexpected end/i, marker);
    assert.equal(f.calls(), '', marker);
    assert.deepEqual(snapshot(f.root), before, marker);
  }
});

test('fresh offline install streamed through stdin builds the helper with separate data in HOME with a space', () => {
  const f = fixture();
  const result = f.run({}, [], readFileSync(installer, 'utf8'));
  assert.equal(result.status, 0, result.output);
  assert.ok(existsSync(join(f.app, 'src/server.ts')));
  assert.ok(existsSync(join(f.app, 'install.sh')));
  assert.ok(statSync(f.data).isDirectory());
  assert.match(readlinkSync(f.app), /^\.app-[a-zA-Z0-9]{6}\/app$/);
  const config = JSON.parse(readFileSync(join(f.helper, 'Contents/Resources/launcher.json'), 'utf8'));
  assert.equal(config.app, f.app);
  assert.equal(config.data, f.data);
  assert.equal(config.port, 4318);
  assert.match(f.calls(), /npm ci --ignore-scripts --omit=dev/);
  assert.doesNotMatch(f.calls(), /brew /);
  assert.match(f.calls(), /open/);
  assert.match(result.output, /Uninstall:/);
});

test('checksum mismatch is refused before npm, build or data creation', () => {
  const f = fixture();
  const broken = join(f.root, 'broken');
  cpSync(release, broken, { recursive: true });
  writeFileSync(join(broken, 'HearAlong.tar.gz.sha256'), `${'0'.repeat(64)}  HearAlong.tar.gz\n`);
  const result = f.run({ HEARALONG_RELEASE_URL: pathToFileURL(broken).href });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /checksum mismatch/);
  assert.ok(!existsSync(f.app));
  assert.ok(!existsSync(f.data));
  assert.doesNotMatch(f.calls(), /npm|swiftc|open/);
});

test('missing Homebrew stops with the official command and no installation changes', () => {
  const f = fixture();
  rmSync(join(f.bin, 'brew'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Homebrew is required/);
  assert.match(result.output, /\/bin\/bash -c "\$\(curl -fsSL https:\/\/raw.githubusercontent.com\/Homebrew\/install\/HEAD\/install.sh\)"/);
  assert.ok(!existsSync(f.appRoot));
  assert.doesNotMatch(f.calls(), /brew |download|npm|swiftc|open/);
});

for (const state of ['missing', 'old']) {
  test(`${state} Node and FFmpeg are installed only via the expected brew formulae`, () => {
    const f = fixture();
    f.ok({ TEST_NODE: state, TEST_FFMPEG: state });
    assert.match(f.calls(), /brew install node@22\n/);
    assert.match(f.calls(), /brew install ffmpeg\n/);
  });
}

test('upgrade preserves data and old code until npm, build and both swaps succeed', () => {
  const f = fixture();
  f.ok();
  const oldTarget = readlinkSync(f.app);
  const oldCode = join(f.appRoot, oldTarget, 'previous-version');
  writeFileSync(oldCode, 'fictional previous code');
  writeFileSync(join(f.data, 'meeting.txt'), 'fictional meeting');
  writeFileSync(join(f.helper, 'previous-helper'), 'fictional helper');
  const before = statSync(f.data);
  for (const failure of ['TEST_NPM_FAIL', 'TEST_BUILD_FAIL', 'TEST_SIGN_FAIL', 'TEST_FAIL_SWAP', 'TEST_FAIL_HELPER_SWAP']) {
    const result = f.run({ [failure]: '1', TEST_OLD_CODE: oldCode });
    assert.notEqual(result.status, 0, failure);
    assert.equal(readlinkSync(f.app), oldTarget, failure);
    assert.equal(readFileSync(oldCode, 'utf8'), 'fictional previous code');
    assert.equal(readFileSync(join(f.helper, 'previous-helper'), 'utf8'), 'fictional helper');
  }
  f.ok({ TEST_OLD_CODE: oldCode });
  assert.notEqual(readlinkSync(f.app), oldTarget);
  assert.ok(!existsSync(oldCode));
  assert.equal(readFileSync(join(f.data, 'meeting.txt'), 'utf8'), 'fictional meeting');
  assert.equal(statSync(f.data).ino, before.ino);
  assert.equal(statSync(f.data).mtimeMs, before.mtimeMs);
});

for (const running of ['helper', 'server']) {
  test(`running HearAlong ${running} blocks installation and uninstall without killing anything`, () => {
    const f = fixture();
    for (const args of [[], ['--uninstall']]) {
      const result = f.run({ TEST_RUNNING: running }, args);
      assert.notEqual(result.status, 0);
      assert.match(result.output, /Please quit HearAlong/);
      assert.ok(!existsSync(f.appRoot));
      assert.doesNotMatch(f.calls(), /download|brew |npm|swiftc|open/);
    }
  });
}

test('a server opened during the build prevents activation', () => {
  const f = fixture();
  f.ok();
  const target = readlinkSync(f.app);
  const result = f.run({ TEST_START_DURING_BUILD: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Please quit HearAlong/);
  assert.equal(readlinkSync(f.app), target);
  assert.ok(!existsSync(join(f.appRoot, '.install-lock')));
});

test('install and uninstall respect an existing installation lock', () => {
  const f = fixture();
  f.ok();
  const target = readlinkSync(f.app);
  mkdirSync(join(f.appRoot, '.install-lock'));
  for (const args of [[], ['--uninstall']]) {
    const result = f.run({}, args);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Another HearAlong install/);
    assert.equal(readlinkSync(f.app), target);
    assert.ok(existsSync(f.helper));
  }
});

test('uninstall leaves all data and prints its path', () => {
  const f = fixture();
  f.ok();
  writeFileSync(join(f.data, 'meeting.txt'), 'fictional meeting');
  const result = f.run({}, ['--uninstall']);
  assert.equal(result.status, 0, result.output);
  assert.ok(!existsSync(f.app));
  assert.ok(!existsSync(f.helper));
  assert.equal(readFileSync(join(f.data, 'meeting.txt'), 'utf8'), 'fictional meeting');
  assert.ok(result.output.includes(f.data));
});

test('Intel Macs proceed with the CPU transcription warning', () => {
  const f = fixture();
  assert.match(f.ok({ TEST_ARCH: 'x86_64' }).output, /transcription is slower on Intel Macs/);
});

test('non-macOS and missing Chrome stop before installation changes', () => {
  const f = fixture();
  assert.match(f.run({ TEST_OS: 'Linux' }).output, /requires macOS/);
  const result = f.run({ HEARALONG_CHROME_APP: join(f.home, 'not-installed.app') });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /needs Google Chrome.*https:\/\/www.google.com\/chrome\//);
  assert.ok(!existsSync(f.appRoot));
  assert.doesNotMatch(f.calls(), /brew |download|npm|swiftc|open/);
});

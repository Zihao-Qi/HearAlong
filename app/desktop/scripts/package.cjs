#!/usr/bin/env node
'use strict';
// Build dependencies must already be installed in desktop/. All downloads, caches, staging and output stay under argv[2].
const { resolve, join } = require('node:path');
const { mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, lstatSync, openSync, readSync, closeSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { packager } = require('@electron/packager');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { assertUnquarantined } = require('../quarantine.cjs');
const NODE_VERSION = '22.22.2';
const ID = 'io.github.zihao-qi.hearalong';
const source = resolve(__dirname, '../..');
const out = process.argv[2] && resolve(process.argv[2]);
if (process.argv.length !== 3 || !out) throw new Error('Usage: node desktop/scripts/package.cjs EMPTY_OUTPUT_FOLDER');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon Mac.');
if (existsSync(out) && readdirSync(out).length) throw new Error('Output folder must be empty.');
mkdirSync(out, { recursive: true });
const cache = join(out, 'cache');
mkdirSync(cache);
const env = { ...process.env, npm_config_cache: join(cache, 'npm'), ELECTRON_CACHE: join(cache, 'electron'), TMPDIR: join(out, 'tmp') };
mkdirSync(env.TMPDIR);
function run(command, args, options = {}) { return execFileSync(command, args, { env, stdio: 'inherit', ...options }); }
function download(url, dest) { run('/usr/bin/curl', ['-fSL', url, '-o', dest]); }
function walk(root) {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name), info = lstatSync(path);
    return info.isSymbolicLink() ? [] : info.isDirectory() ? [...walk(path), path] : [path];
  });
}
function macho(path) {
  if (!lstatSync(path).isFile()) return false;
  const fd = openSync(path, 'r'), magic = Buffer.alloc(4);
  try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
  return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic.toString('hex'));
}
(async () => {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const desktop = JSON.parse(readFileSync(join(source, 'desktop/package.json'), 'utf8'));
  const shell = join(out, 'shell');
  mkdirSync(shell);
  // Explicit allowlist: never copy meetings, test fixtures, development dependencies or local configuration.
  for (const file of ['main.cjs', 'locations.cjs', 'server.cjs', 'policy.cjs', 'preload.cjs']) cpSync(join(source, 'desktop', file), join(shell, file));
  writeFileSync(join(shell, 'starting.html'), readFileSync(join(source, 'desktop/starting.html'), 'utf8').replace('../public/starting.css', './starting.css'));
  cpSync(join(source, 'public/starting.css'), join(shell, 'starting.css'));
  writeFileSync(join(shell, 'package.json'), JSON.stringify({ name: 'hearalong', version: manifest.version, main: 'main.cjs' }));
  const resources = join(out, 'resources');
  const server = join(resources, 'server'), bin = join(resources, 'bin');
  mkdirSync(server, { recursive: true }); mkdirSync(bin);
  for (const file of ['src', 'public', 'pi-extensions', 'package.json', 'package-lock.json']) cpSync(join(source, file), join(server, file), { recursive: true });
  cpSync(resolve(source, '../install.sh'), join(resources, 'install.sh'));
  cpSync(join(source, 'desktop/swap.cjs'), join(resources, 'swap.cjs'));
  cpSync(resolve(source, '../LICENSE'), join(resources, 'LICENSE'));
  cpSync(resolve(source, '../THIRD-PARTY-LICENSES'), join(resources, 'THIRD-PARTY-LICENSES'), { recursive: true });
  run('npm', ['ci', '--ignore-scripts', '--omit=dev'], { cwd: server });
  const archive = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
  download(`https://nodejs.org/dist/v${NODE_VERSION}/${archive}`, join(out, archive));
  download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, join(out, 'SHASUMS256.txt'));
  const expected = readFileSync(join(out, 'SHASUMS256.txt'), 'utf8').split('\n').find(line => line.endsWith(`  ${archive}`))?.split(' ')[0];
  const actual = createHash('sha256').update(readFileSync(join(out, archive))).digest('hex');
  if (!expected || actual !== expected) throw new Error('Official Node SHA-256 mismatch.');
  run('/usr/bin/tar', ['-xzf', join(out, archive), '-C', out]);
  const nodeRoot = join(out, `node-v${NODE_VERSION}-darwin-arm64`);
  cpSync(join(nodeRoot, 'bin/node'), join(bin, 'node'));
  cpSync(join(nodeRoot, 'LICENSE'), join(resources, 'NODE-LICENSE'));
  run('/usr/bin/swiftc', ['-O', '-target', 'arm64-apple-macosx26.0', '-module-cache-path', join(cache, 'swift'), '-o', join(bin, 'pdf-text'), join(source, 'native/pdf-text.swift')]);
  const iconset = join(out, 'AppIcon.iconset'); mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), join(source, 'public/icons/icon-1024.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
  const icon = join(out, 'AppIcon.icns'); run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
  const [folder] = await packager({ dir: shell, out: join(out, 'packaged'), name: 'HearAlong', executableName: 'HearAlong',
    platform: 'darwin', arch: 'arm64', electronVersion: desktop.devDependencies.electron, appBundleId: ID,
    appVersion: manifest.version, buildVersion: manifest.version, asar: true, icon, tmpdir: env.TMPDIR,
    download: { cacheRoot: join(cache, 'electron') }, prune: false,
    extendInfo: { CFBundleName: 'HearAlong', CFBundleDisplayName: 'HearAlong', LSMinimumSystemVersion: '26.0',
      NSMicrophoneUsageDescription: 'HearAlong uses the microphone to transcribe your meetings on this Mac.',
      NSAudioCaptureUsageDescription: 'HearAlong records the audio of the meeting app you choose, to transcribe the call on this Mac.' },
  });
  const app = join(folder, 'HearAlong.app');
  const bundled = join(app, 'Contents/Resources');
  for (const name of readdirSync(resources)) cpSync(join(resources, name), join(bundled, name), { recursive: true, verbatimSymlinks: true });
  await flipFuses(app, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: false });
  const node = join(bundled, 'bin/node');
  // Sign inside-out, without hardened runtime. Preserve the official Node signature if strict validation accepts it.
  const paths = walk(app);
  for (const path of paths.filter(macho)) {
    if (path === node) {
      try { run('/usr/bin/codesign', ['--verify', '--strict', node]); continue; } catch { /* Ad-hoc fallback. */ }
    }
    run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
  }
  for (const path of paths.filter(path => /\.(?:framework|app)$/.test(path) && lstatSync(path).isDirectory())) run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  assertUnquarantined(app, join(out, 'quarantine-attributes.txt'));
  // Both Koffi's arm64 addon and the actual Metal speech dylib must load on the shipped Node, not the build host's Node.
  run(node, ['--input-type=module', '-e', "import { version, libraryPath, getAvailableBackends } from 'transcribe-cpp'; console.log(JSON.stringify({version:version(), library:libraryPath(), backends:getAvailableBackends()}));"], { cwd: join(bundled, 'server') });
  const zip = join(out, 'HearAlong-mac-arm64.zip');
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  writeFileSync(`${zip}.sha256`, `${createHash('sha256').update(readFileSync(zip)).digest('hex')}  HearAlong-mac-arm64.zip\n`);
  writeFileSync(join(out, 'build.json'), JSON.stringify({ app, node: NODE_VERSION, nodeSha256: actual, electron: desktop.devDependencies.electron, version: manifest.version }, null, 2));
  console.log(`Built ${app}\nArchive ${zip}`);
})().catch(error => { console.error(error); process.exitCode = 1; });

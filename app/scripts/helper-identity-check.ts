// Builds only into temporary directories, never launches/registers a helper or touches TCC.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'hearalong-helper-identity-'));
try {
  const first = join(directory, 'first'), second = join(directory, 'second'), data = join(directory, 'data');
  await mkdir(data);
  const bundle = (out: string) => join(out, 'HearAlong Helper.app');
  const environment: NodeJS.ProcessEnv = { ...process.env, HEARALONG_NO_REGISTER: '1' };
  delete environment.HEARALONG_PREVIOUS_HELPER;
  const build = (out: string, extra: NodeJS.ProcessEnv = {}) => execFileSync('sh', ['scripts/build-app.sh', '--install', out, data, join(directory, out === first ? 'code-v1' : 'code-v2')], { env: { ...environment, ...extra }, stdio: 'pipe' });
  const describe = (path: string) => execFileSync('sh', ['-c', 'codesign -dvvv "$1" 2>&1', 'identity-check', path], { encoding: 'utf8' });
  const hash = (path: string) => /CDHash=(\w+)/.exec(describe(path))![1];
  const verify = (path: string) => execFileSync('codesign', ['--verify', '--deep', '--strict', path]);
  build(first);
  const before = hash(bundle(first));
  build(second, { HEARALONG_PREVIOUS_HELPER: bundle(first), PATH: `${directory}:${process.env.PATH}` });
  assert.equal(hash(bundle(second)), before); verify(bundle(second));
  assert.notDeepEqual(await readFile(join(first, 'HearAlong Helper.json')), await readFile(join(second, 'HearAlong Helper.json')));
  assert.equal(JSON.parse(await readFile(join(second, 'HearAlong Helper.json'), 'utf8')).app, join(directory, 'code-v2'));
  assert.deepEqual(await readFile(join(bundle(first), 'Contents/Resources/launcher.json')), await readFile(join(bundle(second), 'Contents/Resources/launcher.json')));
  console.log(`PASS installed staging reuse, changed paths/PATH: codesign -dvvv CDHash=${before} (identical)`);

  // Exact no-argument dev builder path, but in a copied source fixture: never writes the real app/dist.
  const source = join(directory, 'source');
  await mkdir(join(source, 'scripts'), { recursive: true }); await mkdir(join(source, 'public/icons'), { recursive: true });
  await cp('scripts/build-app.sh', join(source, 'scripts/build-app.sh'));
  await cp('launcher', join(source, 'launcher'), { recursive: true });
  await cp('public/icons/icon-1024.png', join(source, 'public/icons/icon-1024.png'));
  const dev = join(source, 'dist'), target = bundle(dev);
  const run = (extra: NodeJS.ProcessEnv = {}) => execFileSync('sh', ['scripts/build-app.sh'], { cwd: source, env: { ...environment, ...extra }, stdio: 'pipe' });
  run(); const initial = hash(target);
  run({ PATH: `${directory}:${process.env.PATH}` });
  assert.equal(hash(target), initial); verify(target);
  const config = await readFile(join(dev, 'HearAlong Helper.json'));
  assert.ok(JSON.parse(config.toString()).path.startsWith(directory));
  const clean = async () => assert.deepEqual((await readdir(dev)).sort(), ['HearAlong Helper.app', 'HearAlong Helper.json']);
  await clean();
  console.log(`PASS in-place dev rebuild with changed PATH: CDHash=${initial} (identical)`);

  for (const tool of ['swiftc', 'codesign', 'lsregister']) {
    const bin = join(directory, `fail-${tool}`); await mkdir(bin);
    const stub = join(bin, tool); await writeFile(stub, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const result = spawnSync('sh', ['scripts/build-app.sh'], { cwd: source, env: { ...environment, PATH: `${bin}:${process.env.PATH}`, ...(tool === 'lsregister' ? { HEARALONG_NO_REGISTER: '0', HEARALONG_LSREGISTER: stub } : {}) }, encoding: 'utf8' });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.equal(hash(target), initial, `${tool} failure restores the previous signed bundle`);
    assert.deepEqual(await readFile(join(dev, 'HearAlong Helper.json')), config);
    verify(target); await clean();
  }
  console.log('PASS compile, sign and registration-stub failures restore output/config; no moved-aside copies left');

  const swift = join(source, 'launcher/main.swift');
  await writeFile(swift, (await readFile(swift, 'utf8')).replace('HearAlong is running', 'Fictional helper identity changed'));
  run(); const changed = hash(target);
  assert.notEqual(changed, initial); verify(target); await clean();
  console.log(`PASS changed Swift input replaces in-place bundle: CDHash=${changed} (different)`);
  const builder = join(source, 'scripts/build-app.sh');
  const original = await readFile(builder, 'utf8');
  const flagsOnly = original.replace(/(swiftc |set -- )-O /, '$1-Onone ');
  assert.notEqual(flagsOnly, original, 'flags-only fixture must change the actual compiler invocation');
  await writeFile(builder, flagsOnly);
  run(); const flagsHash = hash(target);
  assert.notEqual(flagsHash, changed, 'compiler-arguments-only change must not reuse the old signed bundle');
  verify(target); await clean();
  console.log(`PASS flags-only change replaces bundle: CDHash=${flagsHash} (different)`);

  // These temporary probe wrappers change identity metadata, never the actual compiler/SDK used to compile.
  const probes = join(directory, 'toolchain-probes'); await mkdir(probes);
  const xcrun = '/usr/bin/xcrun';
  const compiler = execFileSync('/usr/bin/which', ['swiftc'], { encoding: 'utf8' }).trim();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const realToolEnvironment = `#!/bin/sh\nPATH=${quote(process.env.PATH ?? '')}\nexport PATH\n`;
  await writeFile(join(probes, 'swiftc'), `${realToolEnvironment}exec ${quote(compiler)} "$@"\n`, { mode: 0o755 });
  await writeFile(join(probes, 'xcrun'), `#!/bin/sh\nif [ "$*" = --show-sdk-path ]; then\n  sdk=$(${quote(xcrun)} --show-sdk-path)\n  printf '%s/fictional-sdk\\n' "$sdk"\nelse\n  exec ${quote(xcrun)} "$@"\nfi\n`, { mode: 0o755 });
  run({ PATH: `${probes}:${process.env.PATH}` }); const sdkHash = hash(target);
  assert.notEqual(sdkHash, flagsHash, 'SDK-probe-only change must replace the signed bundle');
  verify(target); await clean();
  console.log(`PASS SDK-path-only change replaces bundle: CDHash=${sdkHash} (different)`);
  await writeFile(join(probes, 'swiftc'), `${realToolEnvironment}if [ "$*" = -version ]; then\n  ${quote(compiler)} -version\n  printf '%s\\n' 'Fictional compiler revision'\nelse\n  exec ${quote(compiler)} "$@"\nfi\n`, { mode: 0o755 });
  run({ PATH: `${probes}:${process.env.PATH}` }); const compilerHash = hash(target);
  assert.notEqual(compilerHash, sdkHash, 'compiler-version-only change must replace the signed bundle');
  verify(target); await clean();
  console.log(`PASS compiler-version-only change replaces bundle: CDHash=${compilerHash} (different)`);
} finally { await rm(directory, { recursive: true, force: true }); }

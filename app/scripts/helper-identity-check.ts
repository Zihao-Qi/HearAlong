// Builds only into temporary directories, never launches/registers a helper or touches TCC.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const build = (out: string, extra: NodeJS.ProcessEnv = {}) => execFileSync('sh', ['scripts/build-app.sh', '--install', out, data, join(directory, out === first ? 'code-v1' : 'code-v2')], { env: { ...environment, ...extra }, encoding: 'utf8', stdio: 'pipe' });
  const describe = (path: string) => execFileSync('sh', ['-c', 'codesign -dvvv "$1" 2>&1', 'identity-check', path], { encoding: 'utf8' });
  const hash = (path: string) => /CDHash=(\w+)/.exec(describe(path))![1];
  const verify = (path: string) => execFileSync('codesign', ['--verify', '--deep', '--strict', path]);
  const outcome = (output: string) => {
    const lines = output.trim().split('\n').filter(line => /^(Reused the signed helper|Built a new helper)/.test(line));
    assert.equal(lines.length, 1, output);
    return lines[0];
  };
  const reused = (output: string, expected: string) => assert.equal(outcome(output), `Reused the signed helper (cdhash ${expected})`);
  const built = (output: string, current: string, previous: string, reason: string) => assert.equal(outcome(output), `Built a new helper (cdhash ${current}; previous ${previous}) because ${reason}`);
  const sourceFiles = (await readdir('launcher')).filter(p => p.endsWith('.swift') && !p.endsWith('Tests.swift')).sort().map(p => `launcher/${p}`);
  const inputs = ['swiftc version', 'SDK path', 'args', ...sourceFiles, 'Contents/Info.plist', 'public/icons/icon-1024.png'];
  const changes = (output: string, expected: string[]) => {
    assert.ok(output.includes(`Changed helper inputs: ${expected.join(', ')}\n`), output);
    const details = output.split('\n').filter(line => line.startsWith('  '));
    assert.equal(details.length, inputs.length, output);
    for (const name of inputs) {
      const line = details.find(line => line.startsWith(`  ${name}: `));
      assert.ok(line, `${name} must have both component digests`);
      const match = /^  .+: previous ([a-f0-9]{64}); current ([a-f0-9]{64})( \(changed\))?$/.exec(line);
      assert.ok(match, line);
      assert.equal(match[1] !== match[2], expected.includes(name), line);
      assert.equal(Boolean(match[3]), expected.includes(name), line);
    }
  };
  const fresh = build(first);
  const before = hash(bundle(first));
  built(fresh, before, 'none', 'no previous bundle');
  // Recompute the pre-diagnostics algorithm, ensuring the new component manifest did not alter reuse rules.
  const fingerprint = createHash('sha256');
  const field = (value: string | Buffer) => { const bytes = Buffer.from(value); fingerprint.update(`${bytes.length}:`); fingerprint.update(bytes); };
  field('swiftc'); field(execFileSync('swiftc', ['-version'], { encoding: 'utf8' }).trimEnd());
  field(execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trimEnd());
  field(JSON.stringify(['-O', 'launcher/main.swift', 'launcher/AudioPipeline.swift', 'launcher/AppAudio.swift', 'launcher/AppCaptureClient.swift', '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'CoreAudio', '-framework', 'AVFoundation', '-o', 'Contents/MacOS/HearAlongHelper']));
  for (const file of [...sourceFiles, 'Contents/Info.plist', 'public/icons/icon-1024.png']) {
    field(file); field(await readFile(file === 'Contents/Info.plist' ? join(bundle(first), file) : file));
  }
  assert.equal(await readFile(join(bundle(first), 'Contents/Resources/helper-inputs.sha256'), 'utf8'), fingerprint.digest('hex'));
  const installed = build(second, { HEARALONG_PREVIOUS_HELPER: bundle(first), PATH: `${directory}:${process.env.PATH}` });
  assert.equal(hash(bundle(second)), before); verify(bundle(second)); reused(installed, before);
  assert.notDeepEqual(await readFile(join(first, 'HearAlong Helper.json')), await readFile(join(second, 'HearAlong Helper.json')));
  assert.equal(JSON.parse(await readFile(join(second, 'HearAlong Helper.json'), 'utf8')).app, join(directory, 'code-v2'));
  assert.deepEqual(await readFile(join(bundle(first), 'Contents/Resources/launcher.json')), await readFile(join(bundle(second), 'Contents/Resources/launcher.json')));
  console.log(`PASS fresh/installed staging messages and unchanged aggregate fingerprint: reused CDHash=${before}`);

  // A verified bundle made before component diagnostics remains reusable, without rewriting its sealed resources.
  const legacy = join(directory, 'legacy.app'); await cp(bundle(first), legacy, { recursive: true });
  await rm(join(legacy, 'Contents/Resources/helper-inputs.json'));
  execFileSync('codesign', ['--force', '--sign', '-', legacy], { stdio: 'pipe' });
  const legacyHash = hash(legacy);
  const legacyOutput = build(join(directory, 'legacy-update'), { HEARALONG_PREVIOUS_HELPER: legacy });
  reused(legacyOutput, legacyHash); verify(bundle(join(directory, 'legacy-update')));
  console.log('PASS legacy signed bundle without component manifest still reuses unchanged');

  const unsigned = join(directory, 'unsigned.app'); await cp(bundle(first), unsigned, { recursive: true });
  execFileSync('codesign', ['--remove-signature', unsigned], { stdio: 'pipe' });
  const unsignedOut = join(directory, 'unsigned-update');
  const unsignedOutput = build(unsignedOut, { HEARALONG_PREVIOUS_HELPER: unsigned });
  const unsignedReason = outcome(unsignedOutput).split(' because ')[1];
  assert.match(unsignedReason, /^previous failed verification: .+/);
  built(unsignedOutput, hash(bundle(unsignedOut)), 'none', unsignedReason); verify(bundle(unsignedOut));
  console.log('PASS unsigned previous bundle reports previous none and a verification failure reason');

  // Exact no-argument dev builder path, but in a copied source fixture: never writes the real app/dist.
  const source = join(directory, 'source');
  await mkdir(join(source, 'scripts'), { recursive: true }); await mkdir(join(source, 'public/icons'), { recursive: true });
  await cp('scripts/build-app.sh', join(source, 'scripts/build-app.sh'));
  await cp('launcher', join(source, 'launcher'), { recursive: true });
  await cp('public/icons/icon-1024.png', join(source, 'public/icons/icon-1024.png'));
  const dev = join(source, 'dist'), target = bundle(dev);
  const run = (extra: NodeJS.ProcessEnv = {}) => execFileSync('sh', ['scripts/build-app.sh'], { cwd: source, env: { ...environment, ...extra }, encoding: 'utf8', stdio: 'pipe' });
  const devFresh = run(); const initial = hash(target); built(devFresh, initial, 'none', 'no previous bundle');
  const devReuse = run({ PATH: `${directory}:${process.env.PATH}` });
  assert.equal(hash(target), initial); verify(target); reused(devReuse, initial);
  const config = await readFile(join(dev, 'HearAlong Helper.json'));
  assert.ok(JSON.parse(config.toString()).path.startsWith(directory));
  const clean = async () => assert.deepEqual((await readdir(dev)).sort(), ['HearAlong Helper.app', 'HearAlong Helper.json']);
  await clean();
  console.log(`PASS in-place dev rebuild with changed PATH: CDHash=${initial} (identical), reuse message`);

  for (const tool of ['swiftc', 'codesign', 'lsregister']) {
    const bin = join(directory, `fail-${tool}`); await mkdir(bin);
    const stub = join(bin, tool); await writeFile(stub, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const result = spawnSync('sh', ['scripts/build-app.sh'], { cwd: source, env: { ...environment, PATH: `${bin}:${process.env.PATH}`, ...(tool === 'lsregister' ? { HEARALONG_NO_REGISTER: '0', HEARALONG_LSREGISTER: stub } : {}) }, encoding: 'utf8' });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /^(Reused the signed helper|Built a new helper)/m, 'a failed build must not report success');
    assert.equal(hash(target), initial, `${tool} failure restores the previous signed bundle`);
    assert.deepEqual(await readFile(join(dev, 'HearAlong Helper.json')), config);
    verify(target); await clean();
  }
  console.log('PASS compile, sign and registration-stub failures restore output/config; no success message or moved-aside copies');

  const swift = join(source, 'launcher/main.swift');
  await writeFile(swift, (await readFile(swift, 'utf8')).replace('HearAlong is running', 'Fictional helper identity changed'));
  const swiftOutput = run(); const changed = hash(target);
  assert.notEqual(changed, initial); verify(target); await clean();
  built(swiftOutput, changed, initial, 'inputs changed'); changes(swiftOutput, ['launcher/main.swift']);
  console.log(`PASS changed Swift input: CDHash=${changed}, both component fingerprints and changed source named`);

  const builder = join(source, 'scripts/build-app.sh');
  const original = await readFile(builder, 'utf8');
  const plistOnly = original.replace('<key>CFBundleVersion</key><string>1</string>', '<key>CFBundleVersion</key><string>2</string>');
  assert.notEqual(plistOnly, original); await writeFile(builder, plistOnly);
  const plistOutput = run(); const plistHash = hash(target);
  built(plistOutput, plistHash, changed, 'inputs changed'); changes(plistOutput, ['Contents/Info.plist']); verify(target);
  const icon = join(source, 'public/icons/icon-1024.png');
  // A PNG may have trailing bytes: change the fingerprint input without requiring another artwork fixture.
  await writeFile(icon, Buffer.concat([await readFile(icon), Buffer.from('\n')]));
  const iconOutput = run(); const iconHash = hash(target);
  built(iconOutput, iconHash, plistHash, 'inputs changed'); changes(iconOutput, ['public/icons/icon-1024.png']); verify(target);
  console.log('PASS Info.plist-only and icon-only changes report both digests and the precise changed component');

  const flagsOnly = plistOnly.replace(/(swiftc |set -- )-O /, '$1-Onone ');
  assert.notEqual(flagsOnly, plistOnly, 'flags-only fixture must change the actual compiler invocation');
  await writeFile(builder, flagsOnly);
  const flagsOutput = run(); const flagsHash = hash(target);
  assert.notEqual(flagsHash, iconHash, 'compiler-arguments-only change must not reuse the old signed bundle');
  built(flagsOutput, flagsHash, iconHash, 'inputs changed'); changes(flagsOutput, ['args']);
  verify(target); await clean();
  console.log(`PASS flags-only change replaces bundle: CDHash=${flagsHash}, args digest changed`);

  // These temporary probe wrappers change identity metadata, never the actual compiler/SDK used to compile.
  const probes = join(directory, 'toolchain-probes'); await mkdir(probes);
  const xcrun = '/usr/bin/xcrun';
  const compiler = execFileSync('/usr/bin/which', ['swiftc'], { encoding: 'utf8' }).trim();
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const realToolEnvironment = `#!/bin/sh\nPATH=${quote(process.env.PATH ?? '')}\nexport PATH\n`;
  await writeFile(join(probes, 'swiftc'), `${realToolEnvironment}exec ${quote(compiler)} "$@"\n`, { mode: 0o755 });
  await writeFile(join(probes, 'xcrun'), `#!/bin/sh\nif [ "$*" = --show-sdk-path ]; then\n  sdk=$(${quote(xcrun)} --show-sdk-path)\n  printf '%s/fictional-sdk\\n' "$sdk"\nelse\n  exec ${quote(xcrun)} "$@"\nfi\n`, { mode: 0o755 });
  const sdkOutput = run({ PATH: `${probes}:${process.env.PATH}` }); const sdkHash = hash(target);
  assert.notEqual(sdkHash, flagsHash, 'SDK-probe-only change must replace the signed bundle');
  built(sdkOutput, sdkHash, flagsHash, 'inputs changed'); changes(sdkOutput, ['SDK path']);
  verify(target); await clean();
  console.log(`PASS SDK-path-only change replaces bundle: CDHash=${sdkHash}, SDK digest changed`);
  await writeFile(join(probes, 'swiftc'), `${realToolEnvironment}if [ "$*" = -version ]; then\n  ${quote(compiler)} -version\n  printf '%s\\n' 'Fictional compiler revision'\nelse\n  exec ${quote(compiler)} "$@"\nfi\n`, { mode: 0o755 });
  const compilerOutput = run({ PATH: `${probes}:${process.env.PATH}` }); const compilerHash = hash(target);
  assert.notEqual(compilerHash, sdkHash, 'compiler-version-only change must replace the signed bundle');
  built(compilerOutput, compilerHash, sdkHash, 'inputs changed'); changes(compilerOutput, ['swiftc version']);
  verify(target); await clean();
  console.log(`PASS compiler-version-only change replaces bundle: CDHash=${compilerHash}, swiftc digest changed`);

  const resource = join(target, 'Contents/Resources/launcher.json');
  await writeFile(resource, `${await readFile(resource, 'utf8')}\n`); // Invalidate the signature, not the input fingerprint.
  const rejectedHash = hash(target);
  const verificationOutput = run({ PATH: `${probes}:${process.env.PATH}` }); const repairedHash = hash(target);
  const verificationReason = outcome(verificationOutput).split(' because ')[1];
  assert.match(verificationReason, /^previous failed verification: .+/);
  built(verificationOutput, repairedHash, rejectedHash, verificationReason);
  verify(target); await clean();
  console.log('PASS previous strict-verification failure builds a new helper and reports the codesign reason');

  const unknownOutput = run({ HEARALONG_PREVIOUS_HELPER: legacy }); const unknownHash = hash(target);
  built(unknownOutput, unknownHash, legacyHash, 'inputs changed');
  assert.match(unknownOutput, /Changed helper inputs: unknown \(previous component digests unavailable\)/);
  for (const name of inputs) assert.ok(unknownOutput.includes(`  ${name}: previous unavailable; current `), name);
  verify(target); await clean();
  console.log('PASS changed legacy inputs report unavailable old component digests explicitly, not fabricated values');
} finally { await rm(directory, { recursive: true, force: true }); }

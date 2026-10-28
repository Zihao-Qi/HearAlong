// npm test must never execute the owner's real Pi, even when a server begins background discovery.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'test-pi-'));
const command = join(directory, 'pi');
// Keep incidental metadata probes cheap across the full suite. Any unintended model request fails loudly.
writeFileSync(command, `#!/bin/sh
case "$1" in
  --no-context-files) printf 'No models available. Use /login to log into a provider.\\n' ;;
  list) printf 'No packages installed.\\n' ;;
  *) echo 'Unexpected Pi call in test: inject a fake runner.' >&2; exit 95 ;;
esac
`);
chmodSync(command, 0o755);
process.env.MEETING_PI = command;
process.env.PI_CODING_AGENT_DIR = join(directory, 'agent'); // Never inspect the real user's package settings in npm test.
delete process.env.FAKE_PI_STATE;
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

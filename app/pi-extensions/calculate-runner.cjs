// Same-realm objects keep mathjs options/config compatible. Seatbelt and Node permissions enforce isolation.
// The gate and macOS can add PWD/SHLVL/encoding variables after spawn; keep the same locale-only allowlist as calculationEnv.
for (const name of Object.keys(process.env)) if (!/^(?:LANG|LC_[A-Z_]+|TZ)$/.test(name)) delete process.env[name];
const fs = require('node:fs');
// An empty entry supports offline development before the pinned dependency is installed. No fallback downloads.
const math = process.argv[2] ? require(process.argv[2]) : undefined;
const code = fs.readFileSync(0, 'utf8');
try {
  new Function('math', 'console', code)(math, console);
} catch (error) {
  console.error(error.code || '', error.stack || String(error));
  process.exitCode = 1;
}

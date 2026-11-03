'use strict';
const { openSync, closeSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

function assertUnquarantined(app, listing) {
  // A recursive listing can exceed execFileSync's buffer for a production dependency tree.
  const fd = openSync(listing, 'w', 0o600);
  try { execFileSync('/usr/bin/xattr', ['-r', app], { stdio: ['ignore', fd, 'inherit'] }); }
  finally { closeSync(fd); }
  if (readFileSync(listing, 'utf8').includes('com.apple.quarantine')) {
    throw new Error('The built app contains com.apple.quarantine; no release archive was created.');
  }
}
module.exports = { assertUnquarantined };

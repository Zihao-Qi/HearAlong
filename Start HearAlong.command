#!/bin/zsh
set -e
cd "${0:A:h}/app"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  print 'Node.js is not on PATH. Start from a terminal with Node >=22.19 configured.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print 'Dependencies are missing. In this folder run: npm ci --ignore-scripts'
  exit 1
fi
print 'Starting HearAlong. This does NOT start recording.'
print 'Keep this terminal open. Press Control-C to stop the server.'
export MEETING_OPEN_BROWSER=1
exec node --experimental-strip-types src/server.ts

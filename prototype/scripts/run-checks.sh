#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node --experimental-strip-types scripts/run-checks.ts "$@"

#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."

for script in install.sh app/scripts/*.sh; do
  # TODO(after pi-app-audio): fix the deferred findings and remove this case block.
  case "$script" in
    install.sh|app/scripts/build-app.sh) continue ;;
  esac
  shellcheck "$script"
done
# ShellCheck does not support zsh (SC1071); retain the launcher's native syntax check.
zsh -n 'Start HearAlong.command'

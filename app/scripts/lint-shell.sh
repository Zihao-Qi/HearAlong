#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."

for script in install.sh app/scripts/*.sh; do
  shellcheck "$script"
done
# ShellCheck does not support zsh (SC1071); retain the launcher's native syntax check.
zsh -n 'Start HearAlong.command'

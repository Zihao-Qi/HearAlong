#!/bin/sh
# One per-user app. Keep the function wrapper: a truncated curl stream must execute nothing.
main() {
set -eu
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'HearAlong requires macOS.'
[ "$(uname -m)" = arm64 ] || fail 'HearAlong supports Apple Silicon only. Intel Macs are not supported yet. Nothing was changed.'
major=$(sw_vers -productVersion)
major=${major%%.*}
case "$major" in *[!0-9]*|'') fail 'Could not determine the macOS version.' ;; esac
[ "$major" -ge 26 ] || fail 'HearAlong requires macOS 26 or newer. Nothing was changed.'
case "${1:-}" in
  '') [ "$#" -eq 0 ] || fail 'Usage: install.sh [--uninstall]' ;;
  --uninstall) [ "$#" -eq 1 ] || fail 'Usage: install.sh [--uninstall]' ;;
  *) fail 'Usage: install.sh [--uninstall]' ;;
esac
# Never redirect a normal install by accident. Test fixtures must opt in explicitly.
home="$HOME"
if [ "${HEARALONG_TEST_MODE:-0}" = 1 ]; then home=${HEARALONG_TEST_HOME:-$HOME}; fi
case "$home" in /*) ;; *) fail 'Home folder must be an absolute path.' ;; esac
ROOT="$home/Library/Application Support/HearAlong"
APPLICATIONS="$home/Applications"
BUNDLE="$APPLICATIONS/HearAlong.app"
APP="$ROOT/app"
DATA="$ROOT/data"
HELPER="$APPLICATIONS/HearAlong Helper.app"
server_running() {
  # server.ts writes String(process.pid), without a newline, and keeps it until shutdown finishes.
  # Read only this PID; never modify the lock or any other meeting data.
  [ -f "$DATA/server.lock" ] && [ ! -L "$DATA/server.lock" ] || return 1
  server_pid=''
  IFS= read -r server_pid < "$DATA/server.lock" || true
  case "$server_pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$server_pid" -gt 0 ] && kill -0 "$server_pid" 2>/dev/null
}
not_running() {
  # One TCP attempt, not an HTTP request: even a non-HTTP listener must block replacement.
  if pgrep -f '/Contents/MacOS/HearAlong(Helper)?([[:space:]]|$)' >/dev/null 2>&1 ||
     nc -z -G 2 127.0.0.1 4318 >/dev/null 2>&1 || server_running; then
    fail 'Please quit HearAlong and wait for it to exit, then run this command again. Nothing was stopped.'
  fi
}
not_running
[ ! -L "$ROOT" ] && [ ! -L "$APPLICATIONS" ] || fail 'The install folders must not be symbolic links; nothing was changed.'
[ ! -d "$ROOT/.install-lock" ] || fail "Another HearAlong install/uninstall may be running. If not, remove $ROOT/.install-lock and retry."
# Recognize only the old installer's relative .app-XXXXXX/app link. Never traverse arbitrary links.
if [ -L "$APP" ]; then
  previous=$(readlink "$APP")
  version=${previous%/app}
  suffix=${version#.app-}
  case "$suffix" in *[!a-zA-Z0-9]*|'') fail "Unrecognized installation at $APP; leave it untouched." ;; esac
  [ "$previous" = "$version/app" ] && [ "$version" = ".app-$suffix" ] && [ "${#suffix}" -eq 6 ] && [ ! -L "$ROOT/$version" ] ||
    fail "Unrecognized installation at $APP; leave it untouched."
elif [ -e "$APP" ]; then
  fail "An unmanaged folder exists at $APP; leave it untouched."
fi
bundle_id() { plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist"; }
managed_bundle() {
  if [ -e "$BUNDLE" ] || [ -L "$BUNDLE" ]; then
    [ -d "$BUNDLE" ] && [ ! -L "$BUNDLE" ] && [ "$(bundle_id "$BUNDLE")" = io.github.zihao-qi.hearalong ] ||
      fail 'An unmanaged HearAlong.app exists; leave it untouched.'
  fi
}
managed_bundle
mkdir -p "$ROOT" "$APPLICATIONS"
mkdir "$ROOT/.install-lock" 2>/dev/null || fail "Another install may be running. If not, remove $ROOT/.install-lock and retry."
stage=''
promoted=0
exchange_pending=0
complete=0
exchange() {
  "$1/Contents/Resources/bin/node" "$1/Contents/Resources/swap.cjs" "$2" "$3"
}
cleanup() {
  trap '' HUP INT TERM
  set +e
  restored=1
  if [ "$complete" -eq 0 ]; then
    if [ "$exchange_pending" -eq 1 ]; then
      current_inode=$(stat -f %i "$BUNDLE" 2>/dev/null)
      if [ "$current_inode" = "$next_inode" ]; then
        if ! exchange "$BUNDLE" "$next" "$BUNDLE"; then
          printf 'Could not restore HearAlong; the previous app is kept at %s\n' "$next" >&2
          restored=0
        fi
      elif [ "$current_inode" != "$old_inode" ]; then
        printf 'Could not confirm the installed app; recovery files are kept in %s\n' "$stage" >&2
        restored=0
      fi
    elif [ "$promoted" -eq 1 ]; then
      # A late replacement is not ours to delete, even after a successful fresh promotion.
      if [ -d "$BUNDLE" ] && [ ! -L "$BUNDLE" ] && [ "$(stat -f %i "$BUNDLE" 2>/dev/null)" = "$next_inode" ]; then rm -rf "$BUNDLE"; fi
    fi
  fi
  if [ -n "$stage" ] && [ "$restored" -eq 1 ]; then rm -rf "$stage"; fi
  rmdir "$ROOT/.install-lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
remove_legacy() {
  rm -f "$APP" "$ROOT/helper.json"
  rm -rf "$HELPER"
  for dir in "$ROOT"/.app-*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] || continue
    base=${dir##*/}
    suffix=${base#.app-}
    case "$suffix" in *[!a-zA-Z0-9]*|'') continue ;; esac
    [ "${#suffix}" -eq 6 ] || continue
    rm -rf "$dir"
    [ ! -e "$dir" ] || fail "Could not remove $dir; cleanup incomplete."
  done
}
if [ "${1:-}" = --uninstall ]; then
  rm -rf "$BUNDLE" "$ROOT/Electron"
  remove_legacy
  printf 'HearAlong removed. Your meetings are kept in %s\n' "$DATA"
  echo 'The old Chrome version can be removed from Chrome.'
  complete=1
  exit 0
fi
release=https://github.com/Zihao-Qi/HearAlong/releases/latest/download
if [ "${HEARALONG_TEST_MODE:-0}" = 1 ]; then release=${HEARALONG_RELEASE_URL:-$release}; fi
case "$release" in
  https://*) ;;
  file://*) [ "${HEARALONG_TEST_MODE:-0}" = 1 ] || fail 'file:// release URLs are permitted only in test mode.' ;;
  *) fail 'Release URL must use https://.' ;;
esac
stage=$(mktemp -d "$APPLICATIONS/.hearalong-XXXXXX")
asset=HearAlong-mac-arm64.zip
echo 'Downloading HearAlong.'
curl -fsSL "$release/$asset" -o "$stage/$asset"
curl -fsSL "$release/$asset.sha256" -o "$stage/$asset.sha256"
# Do not trust filenames from the checksum file.
expected=$(awk 'NR == 1 { print tolower($1) }' "$stage/$asset.sha256")
case "$expected" in *[!a-f0-9]*|'') fail 'Invalid release checksum.' ;; esac
[ "${#expected}" -eq 64 ] || fail 'Invalid release checksum.'
actual=$(shasum -a 256 "$stage/$asset")
actual=${actual%% *}
[ "$expected" = "$actual" ] || fail 'Release checksum mismatch; nothing was installed.'
zipinfo -1 "$stage/$asset" > "$stage/contents"
if ! awk '
  /^\// || /(^|\/)\.\.($|\/)/ { bad=1 }
  !/^HearAlong\.app(\/|$)/ { bad=1 }
  END { exit bad }
' "$stage/contents"; then fail 'Unexpected paths in the release archive.'; fi
ditto -x -k "$stage/$asset" "$stage/unpacked"
next="$stage/unpacked/HearAlong.app"
[ -d "$next" ] && [ ! -L "$next" ] || fail 'The release is incomplete.'
codesign --verify --deep --strict "$next" || fail 'The app signature is invalid; nothing was installed.'
[ "$(bundle_id "$next")" = io.github.zihao-qi.hearalong ] || fail 'The release has the wrong bundle identifier; nothing was installed.'
# curl downloads are not quarantined. Refuse unexpected quarantine instead of bypassing Gatekeeper.
xattr -r "$next" > "$stage/attributes"
if grep -q com.apple.quarantine "$stage/attributes"; then fail 'The downloaded app is quarantined; nothing was installed.'; fi
not_running
managed_bundle
# One atomic same-filesystem exchange on upgrade; the old bundle stays in staging until verification.
# Inodes let the trap detect an exchange even if a signal arrives before the command returns.
next_inode=$(stat -f %i "$next")
if [ -d "$BUNDLE" ]; then
  old_inode=$(stat -f %i "$BUNDLE")
  exchange_pending=1
  exchange "$next" "$next" "$BUNDLE"
else
  # RENAME_EXCL refuses any destination created since managed_bundle (including directories and symlinks).
  "$next/Contents/Resources/bin/node" "$next/Contents/Resources/swap.cjs" --install "$next" "$BUNDLE"
  promoted=1
fi
codesign --verify --deep --strict "$BUNDLE" || fail 'The installed app could not be verified; restoring the previous app.'
complete=1
remove_legacy
printf 'HearAlong is installed in %s\nYour meetings are kept in %s\n' "$BUNDLE" "$DATA"
echo 'The old Chrome version can be removed from Chrome.'
printf 'Uninstall: sh "%s/Contents/Resources/install.sh" --uninstall\n' "$BUNDLE"
open "$BUNDLE"
}

main "$@"

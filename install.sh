#!/bin/sh
# Install a release for this user only. No administrator privileges or user-data migration.
main() {
set -eu
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'HearAlong requires macOS.'
case "$(uname -m)" in
  arm64) ;;
  x86_64) echo 'Note: transcription is slower on Intel Macs (CPU-only speech recognition).' ;;
  *) fail 'HearAlong supports Apple Silicon and Intel Macs only.' ;;
esac
case "${1:-}" in
  '') [ "$#" -eq 0 ] || fail 'Usage: install.sh [--uninstall]' ;;
  --uninstall) [ "$#" -eq 1 ] || fail 'Usage: install.sh [--uninstall]' ;;
  *) fail 'Usage: install.sh [--uninstall]' ;;
esac

ROOT="$HOME/Library/Application Support/HearAlong"
APP="$ROOT/app"
DATA="$ROOT/data"
HELPER="$HOME/Applications/HearAlong Helper.app"
DEFAULT_LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
LSREGISTER=${HEARALONG_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}
if [ "${HEARALONG_TEST_MODE:-0}" != 1 ]; then
  LSREGISTER="$DEFAULT_LSREGISTER"
fi

# Conservatively refuse any listener on the app's port, including a server still starting.
# Do not follow redirects or use proxies, and never stop a running process.
not_running() {
  if pgrep -f '/Contents/MacOS/HearAlongHelper' >/dev/null 2>&1 ||
     curl --noproxy '*' --silent --max-time 2 --output /dev/null http://127.0.0.1:4318/; then
    fail 'Please quit HearAlong (and wait for its helper/server to exit), then run this command again. Nothing was stopped.'
  fi
}
not_running

acquire_lock() {
  mkdir "$ROOT/.install-lock" 2>/dev/null || fail "Another install may be running. If not, remove $ROOT/.install-lock and retry."
}
[ ! -d "$ROOT/.install-lock" ] || fail "Another HearAlong install/uninstall may be running. If not, remove $ROOT/.install-lock and retry."

# Only remove version directories owned by this installer, never an arbitrary symlink target.
previous=''
if [ -L "$APP" ]; then
  previous=$(readlink "$APP")
  version=${previous%/app}
  suffix=${version#.app-}
  case "$suffix" in *[!a-zA-Z0-9]*|'') fail "Unrecognized installation at $APP; leave it untouched." ;; esac
  [ "$previous" = "$version/app" ] && [ "$version" = ".app-$suffix" ] && [ "${#suffix}" -eq 6 ] ||
    fail "Unrecognized installation at $APP; leave it untouched."
elif [ -e "$APP" ]; then
  fail "An unmanaged folder exists at $APP; leave it untouched."
fi

if [ "${1:-}" = --uninstall ]; then
  if [ -d "$ROOT" ]; then
    acquire_lock
    trap 'rmdir "$ROOT/.install-lock"' EXIT
    trap 'exit 1' HUP INT TERM
    if [ -n "$previous" ]; then
      version=${previous%/app}
      rm -rf "$ROOT/${version:?}" 2>/dev/null || true
    fi
    for dir in "$ROOT"/.app-*; do
      [ -d "$dir" ] || continue
      base=$(basename "$dir")
      suffix=${base#.app-}
      case "$suffix" in *[!a-zA-Z0-9]*|'') continue ;; esac
      if [ "${#suffix}" -eq 6 ]; then
        rm -rf "$ROOT/${base:?}" 2>/dev/null || true
      fi
    done
    rm -f "$APP"
    rm -rf "$HELPER"
    for dir in "$ROOT"/.app-*; do
      if [ -d "$dir" ]; then
        fail "Could not remove $dir; uninstall incomplete."
      fi
    done
  fi
  rm -rf "$HELPER"
  printf 'HearAlong removed. Your data is untouched: %s\nHomebrew, Node, FFmpeg and the Chrome web app were not removed.\n' "$DATA"
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  printf '%s\n' 'Homebrew is required (and must be on PATH). Install it yourself with the official command, then rerun:' >&2
  # shellcheck disable=SC2016
  printf '%s\n' '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' >&2
  exit 1
fi
if [ -n "${HEARALONG_CHROME_APP:-}" ]; then
  [ -d "$HEARALONG_CHROME_APP" ] || fail 'HearAlong needs Google Chrome. Get it at https://www.google.com/chrome/, then rerun.'
elif [ ! -d "$HOME/Applications/Google Chrome.app" ] && [ ! -d '/Applications/Google Chrome.app' ]; then
  fail 'HearAlong needs Google Chrome. Get it at https://www.google.com/chrome/, then rerun.'
fi
command -v swiftc >/dev/null 2>&1 || fail 'The Xcode command line tools are required. Run xcode-select --install, then rerun.'

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)'
}
if ! node_ready; then
  echo 'Will install Node.js 22 (node@22) with Homebrew; HearAlong needs Node >= 22.19.'
  brew install node@22
  PATH="$(brew --prefix node@22)/bin:$PATH"
  export PATH
fi
node_ready || fail 'Node >= 22.19 and npm were not found after installation. Check your PATH.'

# FFmpeg 4.4+ supports the audio operations used by HearAlong; require ffprobe too.
ffmpeg_ready() {
  for tool in ffmpeg ffprobe; do
    command -v "$tool" >/dev/null 2>&1 || return 1
    info=$("$tool" -version 2>/dev/null) || return 1
    node -e 'const tool = process.argv[1]; const line = (process.argv[2] || "").split("\n")[0]; const re = new RegExp("^" + tool + " version n?(\\d+)\\.(\\d+)"); const m = re.exec(line); process.exit(m && (+m[1] > 4 || (+m[1] === 4 && +m[2] >= 4)) ? 0 : 1)' "$tool" "$info" || return 1
  done
}
if ! ffmpeg_ready; then
  echo 'Will install FFmpeg (including ffprobe) with Homebrew; HearAlong needs FFmpeg >= 4.4.'
  brew install ffmpeg
  PATH="$(brew --prefix ffmpeg)/bin:$PATH"
  export PATH
fi
ffmpeg_ready || fail 'FFmpeg >= 4.4 and ffprobe were not found after installation. Check your PATH.'

mkdir -p "$ROOT" "$HOME/Applications"
acquire_lock
stage=''
helper_stage=''
activated=0
helper_saved=0
helper_promoted=0
complete=0
cleanup() {
  set +e
  if [ "$complete" -eq 0 ]; then
    if [ "$activated" -eq 1 ]; then
      if [ -n "$previous" ]; then
        rm -f "$ROOT/.rollback"
        ln -s "$previous" "$ROOT/.rollback" 2>/dev/null || true
        node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$ROOT/.rollback" "$APP" 2>/dev/null || true
      else
        rm -f "$APP"
      fi
    fi
    if [ "$helper_promoted" -eq 1 ]; then rm -rf "$HELPER"; fi
    if [ "$helper_saved" -eq 1 ]; then mv "$helper_stage/previous.app" "$HELPER" 2>/dev/null || true; fi
  fi
  rm -f "$ROOT/.next" "$ROOT/.rollback"
  if [ -n "$stage" ] && [ "$complete" -eq 0 ]; then rm -rf "$stage"; fi
  if [ -n "$helper_stage" ]; then rm -rf "$helper_stage"; fi
  rmdir "$ROOT/.install-lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
stage=$(mktemp -d "$ROOT/.app-XXXXXX")
helper_stage=$(mktemp -d "$HOME/Applications/.hearalong-XXXXXX")
DEFAULT_RELEASE_URL=https://github.com/Zihao-Qi/HearAlong/releases/latest/download
release=${HEARALONG_RELEASE_URL:-https://github.com/Zihao-Qi/HearAlong/releases/latest/download}
if [ "${HEARALONG_TEST_MODE:-0}" != 1 ]; then
  release="$DEFAULT_RELEASE_URL"
fi
case "$release" in
  https://*) ;;
  file://*)
    [ "${HEARALONG_TEST_MODE:-0}" = 1 ] || fail 'file:// release URLs are permitted only in test mode.'
    ;;
  *)
    fail 'Release URL must use https://.'
    ;;
esac
asset=HearAlong.tar.gz
printf 'Downloading HearAlong from %s\n' "$release"
curl -fSL "$release/$asset" -o "$stage/$asset"
curl -fSL "$release/$asset.sha256" -o "$stage/$asset.sha256"
# Verify a fixed filename, not filenames supplied by the checksum file.
expected=$(awk 'NR == 1 { print tolower($1) }' "$stage/$asset.sha256")
case "$expected" in *[!a-f0-9]*|'') fail 'Invalid release checksum.' ;; esac
[ "${#expected}" -eq 64 ] || fail 'Invalid release checksum.'
actual=$(shasum -a 256 "$stage/$asset")
actual=${actual%% *}
[ "$expected" = "$actual" ] || fail 'Release checksum mismatch; nothing was installed.'
# Releases contain only tracked source and licenses. Refuse unexpected top-level paths or runtime data.
tar -tzf "$stage/$asset" > "$stage/contents"
if ! awk '
  /^\// || /(^|\/)\.\.($|\/)/ || /(^|\/)(private|data|node_modules|dist)($|\/)/ { bad=1 }
  !/^(app\/|install\.sh$|LICENSE$|THIRD-PARTY-LICENSES\/)/ { bad=1 }
  END { exit bad }
' "$stage/contents"; then fail 'Unexpected paths in the release archive.'; fi
tar -tvzf "$stage/$asset" > "$stage/listing"
if ! awk '
  /^[lh]/ || / -> / || / link to / { bad=1 }
  END { exit bad }
' "$stage/listing"; then fail 'Links are not permitted in the release archive.'; fi
tar -xzf "$stage/$asset" -C "$stage"
rm -f "$stage/$asset" "$stage/$asset.sha256" "$stage/contents" "$stage/listing"
[ -f "$stage/app/package-lock.json" ] && [ -f "$stage/install.sh" ] || fail 'The release is incomplete.'
rm -f "$stage/app/install.sh"
cp "$stage/install.sh" "$stage/app/install.sh"
echo 'Installing pinned runtime packages with npm (no lifecycle scripts).'
(cd "$stage/app" && npm ci --ignore-scripts --omit=dev)
HEARALONG_NO_REGISTER=1 sh "$stage/app/scripts/build-app.sh" --install "$helper_stage" "$DATA" "$APP"
# Recheck immediately before activation: an app opened during download must not be replaced.
not_running
[ -d "$DATA" ] || mkdir "$DATA"
rm -f "$ROOT/.next"
ln -s "$(basename "$stage")/app" "$ROOT/.next"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$ROOT/.next" "$APP"
activated=1
if [ -e "$HELPER" ] || [ -L "$HELPER" ]; then
  mv "$HELPER" "$helper_stage/previous.app"
  helper_saved=1
fi
mv "$helper_stage/HearAlong Helper.app" "$HELPER"
helper_promoted=1
if [ "${HEARALONG_NO_REGISTER:-0}" != 1 ]; then "$LSREGISTER" -f "$HELPER"; fi
complete=1
if [ -n "$previous" ]; then
  version=${previous%/app}
  rm -rf "$ROOT/${version:?}"
fi
printf 'Installed code: %s\nData (kept on upgrade/uninstall): %s\nHelper: %s\n' "$APP" "$DATA" "$HELPER"
printf 'Uninstall: sh "%s/install.sh" --uninstall\n' "$APP"
echo 'Opening HearAlong. In Setup, download the speech model, then open the app.'
open "$HELPER"
}

main "$@"

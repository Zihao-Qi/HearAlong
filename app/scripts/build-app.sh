#!/bin/sh
# Builds "HearAlong Helper.app" (M7) into app/dist/ from launcher/main.swift with the Swift toolchain on this Mac: the
# invisible helper that starts the server for the installed Chrome app "HearAlong" (it opens meetingassistant:// links)
# and shows the mini view in a native floating window while recording.
# By default the build registers the helper with macOS so the link finds it. Rebuild after moving the repo or changing Node.
# Usage: npm run build:app; or build-app.sh --install OUTPUT_DIR DATA_DIR APP_ROOT
# HEARALONG_NO_REGISTER=1 disables LaunchServices registration (required for tests).
set -eu
cd "$(dirname "$0")/.."
APP_ROOT="$(pwd)"
OUTPUT_DIR="$APP_ROOT/dist"
DATA_DIR=""
if [ "${1:-}" = "--install" ] && [ "$#" -eq 4 ]; then
  OUTPUT_DIR="$2"
  DATA_DIR="$3"
  APP_ROOT="$4"
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--install OUTPUT_DIR DATA_DIR APP_ROOT]" >&2
  exit 1
fi
TARGET="$OUTPUT_DIR/HearAlong Helper.app"
# Leave legacy bundles untouched; remove obsolete copies manually after rebuilding.
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "node was not found on PATH" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc was not found (Xcode command line tools)" >&2; exit 1; }
SWIFTC_VERSION="$(swiftc -version)"
SDK_PATH="$(xcrun --show-sdk-path)"

LSREGISTER=${HEARALONG_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}
mkdir -p "$OUTPUT_DIR"
BUILD_TMP="$(mktemp -d "$OUTPUT_DIR/.helper-build-XXXXXX")"
APP="$BUILD_TMP/HearAlong Helper.app"
CONFIG="$OUTPUT_DIR/HearAlong Helper.json"
SAVED=0
PROMOTED=0
CONFIG_SAVED=0
CONFIG_PROMOTED=0
COMPLETE=0
cleanup() {
  if [ "$COMPLETE" -eq 0 ]; then
    if [ "$PROMOTED" -eq 1 ]; then rm -rf "$TARGET"; fi
    if [ "$SAVED" -eq 1 ]; then mv "$BUILD_TMP/previous.app" "$TARGET"; fi
    if [ "$CONFIG_PROMOTED" -eq 1 ]; then rm -f "$CONFIG"; fi
    if [ "$CONFIG_SAVED" -eq 1 ]; then mv "$BUILD_TMP/previous.json" "$CONFIG"; fi
  fi
  rm -rf "$BUILD_TMP"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  mv "$TARGET" "$BUILD_TMP/previous.app"
  SAVED=1
fi
PREVIOUS="${HEARALONG_PREVIOUS_HELPER-$BUILD_TMP/previous.app}"
# An explicit path to this output still refers to the bundle moved aside above.
if [ "$PREVIOUS" = "$TARGET" ] && [ "$SAVED" -eq 1 ]; then PREVIOUS="$BUILD_TMP/previous.app"; fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
set -- -O launcher/main.swift launcher/AudioPipeline.swift launcher/AppAudio.swift launcher/AppCaptureClient.swift -framework Cocoa -framework WebKit -framework CoreAudio -framework AVFoundation -o "$APP/Contents/MacOS/HearAlongHelper"
swiftc "$@"

# The icon, from the app's own (public/icons, drawn by scripts/make-icons.swift).
ICON_TMP="$BUILD_TMP/icons"
mkdir -p "$ICON_TMP"
ICONSET="$ICON_TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size public/icons/icon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) public/icons/icon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>HearAlong Helper</string>
  <key>CFBundleDisplayName</key><string>HearAlong Helper</string>
  <key>CFBundleIdentifier</key><string>local.meeting-research-assistant.helper</string>
  <key>CFBundleExecutable</key><string>HearAlongHelper</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>HearAlong start</string>
    <key>CFBundleURLSchemes</key><array><string>meetingassistant</string></array>
  </dict></array>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.7</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAudioCaptureUsageDescription</key><string>HearAlong records the audio of the meeting app you choose, to transcribe the call on this Mac.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# Paths recorded now, because an app opened from Finder does not get the shell's PATH.
node -e 'process.stdout.write(JSON.stringify({ node: process.argv[1], path: process.argv[2], app: process.argv[3], data: process.argv[4] || undefined, port: 4318 }, null, 2))' \
  "$NODE" "$PATH" "$APP_ROOT" "$DATA_DIR" > "$BUILD_TMP/HearAlong Helper.json"
# Immutable first-build fallback for legacy readers. The helper prefers the external, mutable sidecar.
# Never update this sealed snapshot in a reused bundle (strict codesign rejects out-of-bundle symlinks).
cp "$BUILD_TMP/HearAlong Helper.json" "$APP/Contents/Resources/launcher.json"
node -e '
  const fs = require("node:fs"), crypto = require("node:crypto");
  const hash = crypto.createHash("sha256");
  const field = value => { const bytes = Buffer.from(value); hash.update(String(bytes.length) + ":"); hash.update(bytes); };
  // Normalize only the staged output path: flags, input order and all other arguments remain identity inputs.
  field("swiftc"); field(process.argv[2]); field(process.argv[3]);
  field(JSON.stringify(process.argv.slice(4).map(arg => arg.startsWith(process.argv[1] + "/") ? arg.slice(process.argv[1].length + 1) : arg)));
  const files = fs.readdirSync("launcher").filter(p => p.endsWith(".swift") && !p.endsWith("Tests.swift")).sort().map(p => "launcher/" + p);
  files.push("Contents/Info.plist", "public/icons/icon-1024.png");
  for (const file of files) { field(file); field(fs.readFileSync(file === "Contents/Info.plist" ? process.argv[1] + "/" + file : file)); }
  process.stdout.write(hash.digest("hex"));
' "$APP" "$SWIFTC_VERSION" "$SDK_PATH" "$@" > "$APP/Contents/Resources/helper-inputs.sha256"

codesign --force --sign - "$APP" >/dev/null 2>&1
# Swift embeds a fresh Mach-O UUID, even for unchanged source. Preserve the entire previous signed bundle, not a re-sign.
if [ -n "$PREVIOUS" ] && [ -f "$PREVIOUS/Contents/Resources/helper-inputs.sha256" ] &&
   node -e 'const fs=require("node:fs"); process.exit(fs.readFileSync(process.argv[1],"utf8") === fs.readFileSync(process.argv[2],"utf8") ? 0 : 1)' \
     "$APP/Contents/Resources/helper-inputs.sha256" "$PREVIOUS/Contents/Resources/helper-inputs.sha256" &&
   codesign --verify --deep --strict "$PREVIOUS" >/dev/null 2>&1; then
  rm -rf "$APP"
  cp -R "$PREVIOUS" "$APP"
fi
if [ -e "$CONFIG" ] || [ -L "$CONFIG" ]; then
  mv "$CONFIG" "$BUILD_TMP/previous.json"
  CONFIG_SAVED=1
fi
mv "$BUILD_TMP/HearAlong Helper.json" "$CONFIG"
CONFIG_PROMOTED=1
mv "$APP" "$TARGET"
PROMOTED=1
if [ "${HEARALONG_NO_REGISTER:-0}" != "1" ]; then
  "$LSREGISTER" -f "$TARGET" # so a meetingassistant:// link opens this helper
fi
COMPLETE=1
echo "Built: $TARGET"

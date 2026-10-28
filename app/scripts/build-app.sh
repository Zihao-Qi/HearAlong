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
APP="$OUTPUT_DIR/HearAlong Helper.app"
# Leave legacy bundles untouched; remove obsolete copies manually after rebuilding.
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "node was not found on PATH" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc was not found (Xcode command line tools)" >&2; exit 1; }

LSREGISTER=${HEARALONG_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/HearAlongHelper" launcher/main.swift -framework Cocoa -framework WebKit

# The icon, from the app's own (public/icons, drawn by scripts/make-icons.swift).
ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$ICON_TMP"' EXIT
trap 'exit 1' HUP INT TERM
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
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# Paths recorded now, because an app opened from Finder does not get the shell's PATH.
node -e 'process.stdout.write(JSON.stringify({ node: process.argv[1], path: process.argv[2], app: process.argv[3], data: process.argv[4] || undefined, port: 4318 }, null, 2))' \
  "$NODE" "$PATH" "$APP_ROOT" "$DATA_DIR" > "$APP/Contents/Resources/launcher.json"

codesign --force --sign - "$APP" >/dev/null 2>&1
if [ "${HEARALONG_NO_REGISTER:-0}" != "1" ]; then
  "$LSREGISTER" -f "$APP" # so a meetingassistant:// link opens this helper
fi
echo "Built: $APP"

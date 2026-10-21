#!/bin/sh
# Builds "HearAlong Helper.app" (M7) into prototype/dist/ from launcher/main.swift with the Swift toolchain on this Mac: the
# invisible helper that starts the server for the installed Chrome app "HearAlong" (it opens meetingassistant:// links)
# and shows the mini view in a native floating window while recording.
# Nothing is installed; the build registers the helper with macOS so the link finds it. Rebuild after moving the repo or changing Node.
# Usage: npm run build:app
set -eu
cd "$(dirname "$0")/.."
PROTOTYPE="$(pwd)"
APP="$PROTOTYPE/dist/HearAlong Helper.app"
# Leave legacy bundles untouched; remove obsolete copies manually after rebuilding.
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "node was not found on PATH" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc was not found (Xcode command line tools)" >&2; exit 1; }

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/HearAlongHelper" launcher/main.swift -framework Cocoa -framework WebKit

# The icon, from the app's own (public/icons, drawn by scripts/make-icons.swift).
ICONSET="$(mktemp -d)/AppIcon.iconset"
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
node -e 'process.stdout.write(JSON.stringify({ node: process.argv[1], path: process.argv[2], prototype: process.argv[3], port: 4318 }, null, 2))' \
  "$NODE" "$PATH" "$PROTOTYPE" > "$APP/Contents/Resources/launcher.json"

codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "note: ad-hoc signing failed; the app still runs on this Mac" >&2
"$LSREGISTER" -f "$APP" # so a meetingassistant:// link opens this helper
echo "Built: $APP"

#!/usr/bin/env bash
# Assembles Discord-NDI.app from the SwiftUI shell + the existing Bun backend.
#
# Not `bun build --compile`: its compiled-binary runtime can't resolve grandiose's own
# nested `require("bindings")` at all (confirmed by testing directly, not assumed) — a
# plain bundle run by a real `bun` executable is the only mechanism verified to work.
# See BackendProcess.swift's `bundledBackend` for the layout this produces.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHELL_DIR="$REPO_ROOT/shell/discord-ndi-mac"
OUT_DIR="${1:-$SHELL_DIR/build}"
APP="$OUT_DIR/Discord-NDI.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/backend/node_modules"

echo "swift build -c release"
swift build --package-path "$SHELL_DIR" -c release
cp "$SHELL_DIR/.build/release/DiscordNDI" "$APP/Contents/MacOS/Discord-NDI"

echo "bundling backend"
bun build --external grandiose "$REPO_ROOT/app/index.ts" --outfile "$APP/Contents/Resources/backend/index.js"
cp "$REPO_ROOT/app/payload.ts" "$APP/Contents/Resources/backend/payload.ts"
cp -R "$REPO_ROOT/app/node_modules/grandiose" "$APP/Contents/Resources/backend/node_modules/"
cp -R "$REPO_ROOT/app/node_modules/bindings" "$APP/Contents/Resources/backend/node_modules/"
cp -R "$REPO_ROOT/app/node_modules/file-uri-to-path" "$APP/Contents/Resources/backend/node_modules/"
cp "$(command -v bun)" "$APP/Contents/Resources/backend/bun"
chmod +x "$APP/Contents/Resources/backend/bun"

# assets/Discord-NDI.icon is the real Icon Composer / Liquid Glass source, but
# compiling a bare .icon into Assets.car needs actool driven through an actual Xcode
# project's asset catalog conventions — tried directly against a hand-built .appiconset
# and it doesn't Just Work outside that (confirmed, not assumed). Falls back to the
# flattened .icns (same asset Electrobun uses) via the older CFBundleIconFile until
# there's a real Xcode project to drive proper actool compilation.
cp "$REPO_ROOT/assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Discord-NDI</string>
	<key>CFBundleDisplayName</key>
	<string>Discord-NDI</string>
	<key>CFBundleIdentifier</key>
	<string>sh.aks.discord-ndi</string>
	<key>CFBundleExecutable</key>
	<string>Discord-NDI</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>26.0</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.video</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

echo "assembled: $APP"

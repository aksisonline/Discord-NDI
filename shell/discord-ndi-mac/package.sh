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
# CI passes this from the git tag; local runs fall back to the last released version.
VERSION="${VERSION:-0.1.1}"

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

# assets/Discord-NDI.icon is the Icon Composer / Liquid Glass source. actool compiles it
# into Contents/Resources/Assets.car, which macOS 26 renders natively (layered glass, dark
# and tinted appearances) when the plist names it via CFBundleIconName. actool refuses to
# compile app icons without --output-partial-info-plist; the flag's output plist itself is
# unused here (the keys are written into Info.plist by hand below). stdout is discarded:
# actool always dumps a compilation-results plist there, even with --errors --warnings.
# If compilation fails the following `cp` of the missing Assets.car aborts via `set -e`.
# Its rendered fallback .icns is discarded too: the pre-26 fallback is the existing
# flattened AppIcon.icns (the same asset Electrobun uses), referenced by CFBundleIconFile.
ICON_BUILD="$(mktemp -d)"
trap 'rm -rf "$ICON_BUILD"' EXIT
xcrun actool "$REPO_ROOT/assets/Discord-NDI.icon" \
  --compile "$ICON_BUILD" \
  --platform macosx \
  --minimum-deployment-target 26.0 \
  --app-icon Discord-NDI \
  --output-partial-info-plist "$ICON_BUILD/partial.plist" \
  >/dev/null
cp "$ICON_BUILD/Assets.car" "$APP/Contents/Resources/Assets.car"
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
	<key>CFBundleIconName</key>
	<string>Discord-NDI</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
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
codesign --force --deep -s - "$APP"

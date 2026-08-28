#!/usr/bin/env bash
# Build Vencord with this plugin compiled in, and point your client at it.
#
#   ./install.sh              build + link into the Vencord data dir
#   ./install.sh --inject     also patch the Discord client (only if not patched yet)
#   ./install.sh --repo DIR   use/clone a Vencord checkout at DIR
#
# Vencord has no runtime plugin folder: userplugins are bundled into renderer.js
# by esbuild, so adding a plugin means rebuilding Vencord from source. The
# prebuilt release the installer downloads can never load one. Re-run this after
# editing plugin/ to rebuild.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$HOME/Vencord"
inject=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --inject) inject=true; shift ;;
        --repo) repo="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

case "$(uname -s)" in
    Darwin) data="$HOME/Library/Application Support/Vencord" ;;
    Linux)  data="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord" ;;
    *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

command -v git >/dev/null || { echo "git not found" >&2; exit 1; }

# Vencord builds with pnpm. Don't force a global install on a bun-first machine —
# corepack ships with node, and bunx can fetch it on demand.
if command -v pnpm >/dev/null; then PNPM=(pnpm)
elif command -v corepack >/dev/null; then PNPM=(corepack pnpm)
elif command -v bunx >/dev/null; then PNPM=(bunx pnpm)
else echo "no pnpm, corepack or bunx found — install one" >&2; exit 1
fi
echo "using pnpm via: ${PNPM[*]}"

# --- 1. Vencord source
if [[ ! -d "$repo/src/plugins" ]]; then
    echo "cloning Vencord into $repo"
    git clone --depth 1 https://github.com/Vendicated/Vencord "$repo"
fi
repo="$(cd "$repo" && pwd)"

# --- 2. copy the plugin in.
# Not a symlink: esbuild resolves symlinks to their real path, which lands outside the
# Vencord tree, and tsconfig `paths` (@api, @webpack, @utils) only apply to files inside
# it — so a symlinked plugin fails to build with "Could not resolve @webpack".
# Re-run this script after editing to resync; it is fast once the checkout exists.
target="$repo/src/userplugins/discordNdi"
mkdir -p "$repo/src/userplugins"
rm -rf "$target"
cp -R "$here/plugin" "$target"
echo "copied plugin -> $target"

# --- 3. build
cd "$repo"
"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" build

# --- 4. point the data dir at this build, so an already-injected client picks it up.
# The release dist is kept, not deleted — restore it by swapping the symlink back.
mkdir -p "$data"
if [[ -d "$data/dist" && ! -L "$data/dist" ]]; then
    mv "$data/dist" "$data/dist.release-backup"
    echo "moved the prebuilt dist aside -> $data/dist.release-backup"
fi
rm -f "$data/dist"
ln -s "$repo/dist" "$data/dist"
echo "linked $data/dist -> $repo/dist"

# --- 5. activate
# Injection points differ by platform: macOS swaps the app bundle's app.asar for a
# stub that requires the data-dir patcher, Windows/Linux patch discord_desktop_core.
# Either way the stub points at "$data/dist", which step 4 just aimed at this build,
# so an already-patched client needs nothing further.
patched=false
for probe in \
    /Applications/Discord.app/Contents/Resources/app.asar \
    "$HOME/Library/Application Support/discord"/app-*/modules/discord_desktop_core-*/discord_desktop_core/index.js \
    "$HOME/.config/discord"/*/modules/discord_desktop_core-*/discord_desktop_core/index.js
do
    # `|| true` matters: under `set -e` a non-matching probe would abort the script.
    if [[ -f "$probe" ]] && grep -aqi vencord "$probe"; then patched=true; break; fi
done

if $inject; then
    echo "patching the Discord client (quit Discord first if it is running)"
    "${PNPM[@]}" inject
elif $patched; then
    echo "Discord is already patched and loads $data/dist — nothing more to do."
else
    cat <<HINT

Discord is not patched yet. To patch it:

  cd "$repo" && ${PNPM[*]} inject      # or re-run this script with --inject

A Discord update reverts the patch, which is the usual reason Vencord stops loading.

HINT
fi

cat <<NEXT
done.

  Vesktop        Settings -> Vencord Location -> $repo/dist
  Discord        restart it fully, then enable "DiscordNdi" in Vencord settings

  bridge         bun install --cwd "$here/bridge" && bun run "$here/bridge/index.ts"
  iterating      re-run this script after editing plugin/, then reload Discord
                 (Ctrl+R). Vencord's DevCompanion plugin speeds that up.
NEXT

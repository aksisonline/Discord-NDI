# Discord-NDI (macOS shell)

Native SwiftUI control panel. It does not reimplement capture — it spawns the existing
`app/index.ts` Bun backend as a child process and drives it over its own local HTTP API
(`/api/status`, `/api/source/:key/enabled`, `/api/source/:key/rotation`), the same API
`app/ui.html`'s web panel already uses. All CDP attach/inject and NDI sending stays in
`app/*.ts`, unchanged.

## Run (dev)

```bash
swift run
```

Assumes `bun` on `$PATH` and this checkout's `app/` two directories up (true when run from
here). Override both with env vars for a packaged build: `BUN_PATH`, `DISCORD_NDI_APP_DIR`
(the directory containing `index.ts`).

## Known ceilings

- Not yet packaged as a distributable `.app` — no bundled Bun runtime, no bundled
  `grandiose`/NDI runtime, no code signing. `shell/discord-ndi/` (Electrobun) is still
  the one CI actually builds and releases.
- No Dock icon/menu bar polish yet — it's the same three-line status + source list as
  the web panel, just in a real window instead of a webview.

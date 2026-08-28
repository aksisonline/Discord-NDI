# Recon notes

Findings from probing the live official Discord client. `app/probe.ts` runs an expression
in its renderer over CDP, which is how all of this was established:

```bash
bun run app/probe.ts /tmp/expr.js
```

## 1. Which elements carry remote media?

```js
[...document.querySelectorAll("audio,video")].map(e => ({
    tag: e.tagName,
    tracks: e.srcObject?.getTracks().map(t => t.kind)
}))
```

Expected: one `<video>` per camera/screen tile, and either one `<audio>` per remote user or
a single mixed one. `tap.ts` assumes per-user elements — if audio turns out to be a single
mixed element, the Web Audio graph or the SSRC fallback below is required instead.

## 2. Does the fiber walk find a userId?

```js
const el = document.querySelector("video");
let f = el[Object.keys(el).find(k => k.startsWith("__reactFiber$"))];
for (let i = 0; f && i < 30; i++, f = f.return) console.log(i, f.memoizedProps);
```

Look for `userId`, `user.id`, `participant.user.id`, or `streamKey`. `resolveOwner()` in
`tap.ts` checks exactly those — widen it here if the real prop name differs.

## 3. Fallback mapping (DOM-independent)

If the fiber walk proves brittle, map SSRC to user instead: the voice gateway sends
`speaking` (op 5) carrying `user_id` and `audio_ssrc`, plus video opcodes with `video_ssrc`.
Cross-reference against `pc.getStats()` → `inbound-rtp.ssrc`, or
`receiver.getSynchronizationSources()`. This survives UI refactors; the fiber walk does not.

## 4. Does the outbound track carry Discord's processing?

```js
[...document.querySelectorAll("video")].length; // just to have a PC alive
// then, on any RTCPeerConnection Discord owns:
pc.getSenders().map(s => [s.track?.kind, s.track?.getSettings()])
```

Audio sender settings should report `echoCancellation`/`noiseSuppression`/`autoGainControl`.
If Discord instead runs Krisp as a WASM AudioWorklet *upstream* of the sender, the sender
track is still the right tap — it is whatever gets transmitted either way. If it turns out
to be the raw device track, the tap has to move to the worklet's output node instead.

## 5. Is remote video reachable on the *official* client at all?

Only worth answering out of curiosity — audio is out either way (see README). Enable
DevTools on the official client (`DISCORD_ENABLE_DEVTOOLS=1`), join a call with someone's
camera on, and run:

```js
[...document.querySelectorAll("video, canvas")].map(e => ({
    tag: e.tagName,
    stream: (e as any).srcObject ?? null,
    ctx: e.tagName === "CANVAS" ? "canvas — frames come from native, not tappable as a track" : null
}))
```

A `<video>` with a live `srcObject` means video is reachable. A bare `<canvas>`, or a
`<video>` with a null `srcObject`, means the native engine is painting frames and there is
no MediaStreamTrack to clone.

## Findings

Confirmed on the official Discord client (macOS, app-0.0.409, Aug 2026):

- **Remote video is reachable.** Each participant's camera arrives on a plain `<video>`
  with a live `srcObject` carrying a real video track (1280x720 observed). The native
  media engine renders through Chromium after all.
- **Those `<video>` elements have no React fiber.** `__reactFiber$` is absent — they are
  created imperatively. Their ancestors *do* have fibers, so a fiber walk must start at
  `el.parentElement`.
- **Identity comes from the tile, not the fiber.** The enclosing tile div carries
  `data-selenium-video-tile="<userId>"`. `resolveOwner()` uses `closest()` on that and
  keeps the fiber walk only as a fallback.
- **Your own tile is included**, distinguishable by the `mirror__*` class on the video
  wrapper.
- **Audio never appears.** No `<audio>` elements, no audio tracks on any stream — the
  native engine mixes and plays in C++. Per-user audio needs Vesktop.

- **Discord swaps tracks mid-call.** A participant's resolution changes produce a *new*
  `MediaStreamTrack` with a new `deviceId` on the same tile (1280x720 -> 640x360 ->
  896x504 all observed). A pump bound to the first track therefore freezes at whatever
  size it started with. `bound` (element -> current tracks) plus a 2s reconcile handles
  both mechanisms — srcObject replacement and in-place stream mutation.
- **There is no rotation metadata.** Every ancestor reports `transform: none` and
  `rotate: none`; the only transform is `matrix(-1,0,0,1,0,0)` on the self tile, which is
  the `mirror__*` horizontal flip. Rotating a phone reads as "NDI orientation is stuck"
  purely because of the stale-track bug above, not because Discord rotates at render.
  NDI output is deliberately unmirrored — the mirror is a local UI nicety.
- **A camera and a Go Live from the same person share one tile id.** They are told apart
  by wrapper: camera tiles sit inside `previewWrapper_*` (alongside `effectsWrapper_*`),
  Go Live tiles inside `videoContainer_*`. Class hashes change between builds, so match
  the prefix. `resolveOwner` warns when neither matches rather than silently guessing.

## Privacy & consent gate

Republishing every other person's video as its own NDI source is a privacy-affecting
action for the *whole call*, not just the local user. Two behaviors are agreed:

1. **Refuse to run unless the user has Discord's "Activity Status" enabled** (User
   Settings → Activity → Activity Status — the toggle that broadcasts their current
   activity to others; this is what the request calls "Activity Rich Presence").
   Rationale: it is the one Discord-blessed, *visible* opt-in to "I am sharing what I'm
doing," and gating on it stops the tool working silently for someone who has told
   Discord not to surface their activity. With it off, `Controller.start()` must abort
   **before** injecting the tap and show a clear panel message ("Enable Activity Status
to use Discord-NDI").

2. **Emit a Rich Presence while capturing.** So every participant in the VC sees
   "Discord-NDI is capturing this call" on the user's profile/name — the in-call
   transparency that makes the capture consensual for the people being captured. Set it
   on `start()` and clear it on `stop()`.

Both go in `app/index.ts` (gate in `Controller.start`) + `app/payload.ts` (presence
setter), reflected in `app/ui.html`. Open questions — **do not guess from abstractions**;
find both over CDP with `app/probe.ts` the same way everything else here was established:

- **Detecting Activity Status.** Where does the official client expose the toggle? Almost
  certainly a key in Discord's local settings store, reachable from the injected payload
  the way the username lookup in the Findings section is. Probe `window`-attached setting
  stores / `DiscordNative` to find the exact key and value shape.
- **Setting Rich Presence from the official client.** The app is already injected into the
  renderer, so the cheapest, VC-visible path is to call Discord's internal presence
  setter (the same module that powers "Playing X") from the payload — not a separate RPC
  client. The alternative is a Discord RPC client over the local `discord-ipc-*` socket,
  which shows as a game/activity and is more code. Confirm via probe which API the client
  actually exposes before writing the call.

## Packaging (Electrobun)

Verified on macOS arm64:

- `mainProcess: "bun"` in `electrobun.config.ts` is required. Electrobun 2.0 defaults to
  Cottontail, and the NDI binding is an N-API addon that needs a Node-API host.
- `hutch electrobun build --env=stable` produces `Discord-NDI.app` plus a `.dmg`. The app
  self-extracts to `~/Library/Application Support/sh.aks.discord-ndi/stable` on first run,
  serves the panel, and reports `ndi: true`.

**Self-contained, verified.** The earlier gap — `grandiose external` kept it out of the JS
bundle but copied it nowhere, so `ndi: true` only worked because the dev tree's
`app/node_modules` was reachable — is closed. `app/bunfig.toml` pins `linker = "hoisted"`
so grandiose's transitive deps (`bindings`, `file-uri-to-path`) install as flat top-level
siblings instead of Bun's isolated-store layout (which nests them under version-hashed
paths like `.bun/bindings@1.5.0/node_modules/bindings`), and three `copy` rules in
`electrobun.config.ts` place grandiose + bindings + file-uri-to-path at
`bun/node_modules/<name>` in the bundle. Verified by renaming `app/node_modules/grandiose`
aside and launching the built `.app`: `/api/status` reports `ndi: true` with the dev tree
unreachable. `libndi.dylib` rides along inside grandiose's folder (loads via `@loader_path`,
confirmed with `otool -l`).

Windows is entirely untested — no Windows machine was available. `app/discord.ts` has the
platform-specific launch path (`%LOCALAPPDATA%\Discord\Update.exe --processStart
Discord.exe --process-start-args`), but nothing on that path has been run.

grandiose has no prebuilt binaries and compiles via node-gyp, so a Windows build needs
Visual Studio build tools on the *build* machine; end users must not be asked for that.
That means building the addon per-platform in CI and shipping the artifacts.

Redistributing the NDI runtime (`libndi.dylib`, `Processing.NDI.Lib.x64.dll`) is covered by
NewTek/Vizrt's licence, not grandiose's Apache-2.0 — worth reading before publishing
installers.

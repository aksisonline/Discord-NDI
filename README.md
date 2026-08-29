# Discord-NDI

Every participant in your Discord call as its own NDI source, so OBS/vMix can composite
them individually. Yourself included, cameras and Go Live alike.

A standalone app. It does not modify Discord's install: it attaches to the running client
over the Chrome DevTools Protocol, injects a small tap into the renderer, and pulls frames
out. Turning it off really turns it off, and a Discord update cannot break it.

```
Discord renderer            │  ws://127.0.0.1:9191  │  Discord-NDI (Bun)
─────────────────────────── │ ───────────────────── │ ─────────────────────
injected payload.ts         │                       │  ndi.ts + grandiose
  find per-user <video>     │  [24B hdr][BGRA]      │    1 NDI sender/source
  MediaStreamTrackProcessor │ ────────────────────► │    "Discord – Alice"
        ▲                   │                       │  ui.html control panel
        └── injected over CDP ──────────────────────┘
```

## Run

```bash
bun install --cwd app && bun run app/index.ts
```

Opens a control panel at <http://127.0.0.1:9333> with an on/off switch and a live list of
what is publishing. Discord must be running with remote debugging enabled; if it isn't,
the app relaunches it for you:

```bash
open -a Discord --args --remote-debugging-port=9222
```

Flags: `--port` (frame ingest, 9191), `--debug-port` (CDP, 9222), `--ui` (panel, 9333),
`--headless` (no panel), `--dry` (run without NDI output).

## What gets captured

| | Official Discord | Vesktop / browser |
| --- | --- | --- |
| Remote cameras and Go Live | yes | yes |
| Your own camera | yes | yes |
| Audio | no | yes, not yet wired |

Video works on the official client, which is not obvious. Voice and video run through
`discord_voice.node`, a C++ addon on native libwebrtc, yet the media engine still hands
each participant's video to a plain `<video>` with a live `srcObject`.

Audio does not. The native engine decodes, mixes and plays it entirely in C++, out to the
OS device — nothing per-user reaches JavaScript. Capturing the app's system audio does not
help either, since the mix has already happened. The wire protocol and NDI side carry
audio already; only a client that exposes audio tracks (Vesktop, or Discord in a browser)
is missing.

## How participants are identified

Discord's `<video>` elements are created imperatively and carry no React fiber, so:

- **Who** — the enclosing tile tags itself `data-selenium-video-tile="<userId>"`.
- **Camera vs Go Live** — both share that id. Cameras render inside `previewWrapper_*`,
  Go Live inside `videoContainer_*`. Class hashes change between builds, so the match is on
  prefix.
- **Names** — tiles carry none, and without Vencord there is no store to ask. They come
  from the member list, pairing a `usernameFont_*` label with an avatar whose URL embeds
  the user id. Users on a default avatar fall back to their id.

All three are Discord internals with no stability guarantee.

## Layout

| Path | What |
| --- | --- |
| `app/index.ts` | Controller: attach, inject, on/off, control panel |
| `app/cdp.ts` | Minimal Chrome DevTools Protocol client |
| `app/payload.ts` | Injected renderer tap (self-contained, no imports) |
| `app/ndi.ts` | Frame ingest + grandiose senders |
| `app/protocol.ts` | Wire format |
| `app/probe.ts` | Dev helper: run an expression in Discord's renderer |
| `plugin/`, `install.sh` | Legacy Vencord plugin — see below |

## Packaging

The app is plain Bun, so [Electrobun](https://framework.blackboard.sh/electrobun/) is a
natural shell: its main process *is* Bun, and grandiose is a genuine N-API addon — its
binary references only `napi_*` symbols, no V8 or node internals — so it loads without a
rebuild. `ui.html` is already the whole interface. The one thing to verify is that
Electrobun's bundled Bun has N-API enabled.

## Privacy

Discord-NDI republishes *other people's* video, so it is built to be consensual by
default:

- It refuses to attach unless you have Discord's **Activity Status** enabled (the toggle
  that broadcasts your current activity to others). No activity sharing → no capture.
- While capturing, it sets a **Rich Presence** reading *"Discord-NDI is capturing this
  call"* on your profile, so everyone in the VC can see they are being captured.

See `app/index.ts` (`Controller.start`) and `app/payload.ts` for the literal enforcement
points.

## Known ceilings

- Frames cross the socket uncompressed: 720p30 BGRA ≈ 55 MB/s per source, fine to roughly
  four on loopback. Beyond that, encode with WebCodecs or move to shared memory.
- Sender frame rate is advertised as a flat 30fps; receivers sync off timecode.
- Output is unmirrored even where Discord mirrors your own camera, and follows Discord's
  own resolution changes rather than pinning one size.
- `grandiose`'s bundled `index.d.ts` is stale: it documents the *receiver* audio frame
  (`channels`, `samples`, `channelStrideInBytes`) while the sender's C++ reads
  `noChannels`, `noSamples`, `channelStrideBytes` — and requires a `fourCC` the typings
  omit. Omitting it segfaults the process rather than throwing. Trust
  `src/grandiose_send.cc`, not the typings.
- Client automation like this violates Discord's ToS. Enforcement against non-abusive
  tooling has historically been nil, but it is your account.

## Layout notes

`app/protocol.ts` carries a comment pointing at `plugin/wire.ts` for the encoder half of the
wire format. That `plugin/` tree — an earlier Vencord-userplugin approach — was intentionally
deleted once the standalone app worked and was committed; the comment points at git
history now. The standalone app needs no Vencord, so the two-tap divergence problem is gone.

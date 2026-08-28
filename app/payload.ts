/*
 * Injected into Discord's renderer over CDP. Runs with no Vencord and no imports —
 * bundled to a single self-contained script by Bun.build, then evaluated in the page.
 *
 * Finds each participant's video track, pulls frames, and ships them to the Discord-NDI
 * app over a local WebSocket.
 */

declare const __PORT__: number;

const HEADER = 24;
const TYPE = { VIDEO: 1, AUDIO: 2, HELLO: 3, BYE: 4 };
const RECONCILE_MS = 2000;
const RECONNECT_MS = 2000;
const textEncoder = new TextEncoder();

function encode(type: number, id: string, flags: number, a: number, b: number, ts: number, payload: Uint8Array) {
    const idBytes = textEncoder.encode(id);
    const buf = new ArrayBuffer(HEADER + idBytes.length + payload.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, type);
    view.setUint8(1, flags);
    view.setUint16(2, idBytes.length, true);
    view.setUint32(4, a, true);
    view.setUint32(8, b, true);
    view.setUint32(12, payload.byteLength, true);
    view.setFloat64(16, ts, true);
    const bytes = new Uint8Array(buf);
    bytes.set(idBytes, HEADER);
    bytes.set(payload, HEADER + idBytes.length);
    return buf;
}

interface Owner { userId: string; screenshare: boolean; name: string; }

/**
 * Which participant a <video> belongs to.
 *
 * These elements are created imperatively by Discord's media engine and carry no React
 * fiber, but the enclosing tile tags itself with the user id. A camera and a Go Live from
 * the same person share that id, so they are told apart by wrapper: cameras render inside
 * previewWrapper_*, Go Live inside videoContainer_*. Class hashes change between Discord
 * builds, hence the prefix match.
 */
function resolveOwner(el: Element): Owner | null {
    const tile = el.closest("[data-selenium-video-tile]");
    const userId = tile?.getAttribute("data-selenium-video-tile");
    if (!userId || !/^\d{17,20}$/.test(userId)) return null;

    const camera = el.closest('[class*="previewWrapper_"]');
    const stream = el.closest('[class*="videoContainer_"]');
    const screenshare = !!stream && !camera;

    return { userId, screenshare, name: names.get(userId) ?? userId };
}

/**
 * userId -> display name.
 *
 * Video tiles carry no name at all, and without Vencord there is no store to ask, so the
 * names come from the member list: each row pairs a `usernameFont_*` label with an avatar
 * whose URL embeds the user id. Users on a default avatar have no id in the URL and fall
 * back to their id.
 */
const names = new Map<string, string>();

function refreshNames() {
    // Walk avatar -> name, not name -> avatar: the avatar URL is the only thing carrying
    // the user id, and the name label sits below a shared ancestor a few levels up.
    // Filtering to usernameFont_* avoids picking up server names and status text.
    for (const avatar of document.querySelectorAll('img[src*="/avatars/"], [style*="/avatars/"]')) {
        const src = avatar.getAttribute("src") ?? avatar.getAttribute("style") ?? "";
        const id = src.match(/\/avatars\/(\d{17,20})\//)?.[1];
        if (!id) continue; // default avatars carry no id

        for (let row: Element | null = avatar, d = 0; row && d < 6; row = row.parentElement, d++) {
            const label = row.querySelector('[class*="usernameFont"]');
            const text = label?.textContent?.trim();
            if (text) {
                names.set(id, text);
                break;
            }
        }
    }
}

const sourceKey = (o: Owner) => (o.screenshare ? `${o.userId}:screen` : o.userId);
const sourceName = (o: Owner) => (o.screenshare ? `Discord – ${o.name} – Screen` : `Discord – ${o.name}`);

class Tap {
    private ws: WebSocket | null = null;
    private retry: any = null;
    stopped = false;
    private sources = new Map<string, { abort: AbortController; tracks: Set<MediaStreamTrack>; }>();
    private announced = new Map<string, string>();
    /**
     * What each element currently publishes. Discord swaps in a brand new track when a
     * participant's resolution or orientation changes, so without this the pump stays
     * bound to the first track and the output freezes at its starting size.
     */
    private bound = new WeakMap<HTMLMediaElement, MediaStreamTrack[]>();

    start() {
        this.connect();
        const timer = setInterval(() => this.reconcile(), RECONCILE_MS);
        (this as any).timer = timer;
        this.reconcile();
    }

    stop() {
        this.stopped = true;
        clearInterval((this as any).timer);
        if (this.retry) clearTimeout(this.retry);
        for (const s of this.sources.values()) s.abort.abort();
        this.sources.clear();
        this.announced.clear();
        this.ws?.close();
        this.ws = null;
    }

    private connect() {
        if (this.stopped) return;
        const ws = new WebSocket(`ws://127.0.0.1:${__PORT__}`);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        ws.onopen = () => {
            // Re-announce everything; the app has no memory of a dropped socket.
            for (const [key, name] of this.announced) this.sendHello(key, name);
        };
        ws.onclose = ws.onerror = () => {
            if (this.ws === ws) this.ws = null;
            if (!this.stopped && !this.retry) {
                this.retry = setTimeout(() => { this.retry = null; this.connect(); }, RECONNECT_MS);
            }
        };
    }

    private get ready() { return this.ws?.readyState === WebSocket.OPEN; }

    private sendHello(key: string, name: string) {
        this.ws!.send(encode(TYPE.HELLO, key, 0, 0, 0, 0, textEncoder.encode(JSON.stringify({ name }))));
    }

    /**
     * Re-scan the DOM. Catches Discord replacing srcObject and mutating a stream in
     * place, which fires no event at all.
     */
    private reconcile() {
        refreshNames();
        const seen = new Set<string>();

        for (const el of document.querySelectorAll("video")) {
            const stream = el.srcObject as MediaStream | null;
            if (!stream) continue;
            const owner = resolveOwner(el);
            if (!owner) continue;

            const key = sourceKey(owner);
            seen.add(key);
            const tracks = stream.getVideoTracks();

            const previous = this.bound.get(el) ?? [];
            for (const track of previous) if (!tracks.includes(track)) this.detach(key, track);
            this.bound.set(el, tracks);

            for (const track of tracks) this.attach(key, sourceName(owner), track);
        }

        // Anything that vanished from the DOM entirely — someone left, or stopped their camera.
        for (const key of [...this.sources.keys()]) {
            if (!seen.has(key)) this.retire(key);
        }
    }

    private attach(key: string, name: string, track: MediaStreamTrack) {
        if (track.readyState === "ended") return;

        let source = this.sources.get(key);
        if (!source) {
            source = { abort: new AbortController(), tracks: new Set() };
            this.sources.set(key, source);
            this.announced.set(key, name);
            if (this.ready) this.sendHello(key, name);
        }
        if (this.announced.get(key) !== name) {
            // The member list can populate after the tile does; adopt the real name.
            this.announced.set(key, name);
            if (this.ready) this.sendHello(key, name);
        }
        if (source.tracks.has(track)) return;
        source.tracks.add(track);

        const drop = () => this.detach(key, track);
        track.addEventListener("ended", drop, { once: true });
        this.pump(key, track, source.abort.signal).finally(drop);
    }

    private detach(key: string, track: MediaStreamTrack) {
        const source = this.sources.get(key);
        if (!source?.tracks.delete(track)) return;
        if (source.tracks.size === 0) this.retire(key);
    }

    private retire(key: string) {
        const source = this.sources.get(key);
        if (!source) return;
        source.abort.abort();
        this.sources.delete(key);
        this.announced.delete(key);
        if (this.ready) this.ws!.send(encode(TYPE.BYE, key, 0, 0, 0, 0, new Uint8Array(0)));
    }

    private async pump(key: string, track: MediaStreamTrack, signal: AbortSignal) {
        // Clone so Discord's teardown doesn't kill our read, and ours doesn't disturb playback.
        const clone = track.clone();
        const reader = new (window as any).MediaStreamTrackProcessor({ track: clone }).readable.getReader();
        signal.addEventListener("abort", () => {
            reader.cancel().catch(() => { });
            clone.stop();
        }, { once: true });

        try {
            while (!signal.aborted) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                try {
                    // Drop rather than queue: a backed-up socket must not grow latency.
                    if (this.ready && this.ws!.bufferedAmount < 8e6) {
                        const buf = new Uint8Array(value.allocationSize({ format: "BGRA" }));
                        await value.copyTo(buf, { format: "BGRA" });
                        if (this.ready) {
                            this.ws!.send(encode(TYPE.VIDEO, key, 0, value.codedWidth, value.codedHeight, value.timestamp, buf));
                        }
                    }
                } finally {
                    // A leaked VideoFrame stalls the pipeline within seconds.
                    value.close();
                }
            }
        } catch (err) {
            if (!signal.aborted) console.error(`[Discord-NDI] pump ${key} died`, err);
        } finally {
            clone.stop();
        }
    }
}

// Re-injection must not leave two taps running.
(globalThis as any).__discordNdi?.stop();
const tap = new Tap();
(globalThis as any).__discordNdi = tap;
tap.start();

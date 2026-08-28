/*
 * Discord-NDI: find every MediaStreamTrack in the current call and route it to the bridge.
 *
 * Two halves:
 *
 *   Remote participants — a setter patch on HTMLMediaElement.prototype.srcObject. The web
 *   client attaches every remote camera, screen share and voice stream to a media element,
 *   so one hook catches all of them. Enabling the plugin mid-call is covered by sweep(),
 *   which walks elements that already had srcObject set before we patched it.
 *
 *   Yourself — patches on the outbound side of RTCPeerConnection. sender.track is the
 *   track Discord actually transmits, i.e. *after* its own noise suppression, echo
 *   cancellation and AGC, and before encoder bitrate limits. That is the post-processed
 *   feed, at full source quality.
 */

import { findStoreLazy } from "@webpack";

import { pump, Wire } from "./wire";

const UserStore = findStoreLazy("UserStore");

/** How long to keep retrying the fiber walk while React attaches a fresh element. */
const FIBER_RETRIES = 5;
const FIBER_RETRY_MS = 50;
/** How often to re-check which tracks each element is publishing. */
const RECONCILE_MS = 2000;

interface Source {
    abort: AbortController;
    tracks: Set<MediaStreamTrack>;
}

interface Owner {
    userId: string;
    screenshare: boolean;
}

let wire: Wire | null = null;
let captureSelf = true;
const undo: Array<() => void> = [];
const sources = new Map<string, Source>();
/** Outbound tracks already attached, so repeated getSenders() sweeps stay idempotent. */
const seenOutbound = new WeakSet<MediaStreamTrack>();
/**
 * What each media element is currently publishing. Discord swaps in a brand new track
 * when a participant's resolution or orientation changes — same tile, new deviceId — so
 * without this the pump stays bound to the first track forever and the NDI output freezes
 * at whatever size it started with.
 */
const bound = new WeakMap<HTMLMediaElement, { key: string; tracks: MediaStreamTrack[]; }>();

/* ------------------------------------------------------------------ registry */

function sourceKey(owner: Owner) {
    return owner.screenshare ? `${owner.userId}:screen` : owner.userId;
}

function sourceName(owner: Owner) {
    const username = UserStore.getUser(owner.userId)?.username ?? owner.userId;
    return owner.screenshare ? `Discord – ${username} – Screen` : `Discord – ${username}`;
}

/** A user's camera and mic share one NDI sender, so tracks accumulate under one key. */
function attach(owner: Owner, track: MediaStreamTrack) {
    if (!wire || track.readyState === "ended") return;

    const key = sourceKey(owner);
    let source = sources.get(key);
    if (!source) {
        source = { abort: new AbortController(), tracks: new Set() };
        sources.set(key, source);
        wire.hello(key, sourceName(owner));
    }
    if (source.tracks.has(track)) return;
    source.tracks.add(track);

    const drop = () => detach(key, track);
    track.addEventListener("ended", drop, { once: true });

    pump(wire, key, track, source.abort.signal).finally(drop);
}

/** Tear the NDI sender down only once the user's last track is gone. */
function detach(key: string, track: MediaStreamTrack) {
    const source = sources.get(key);
    if (!source?.tracks.delete(track)) return;
    if (source.tracks.size) return;

    source.abort.abort();
    sources.delete(key);
    wire?.bye(key);
}

/* ------------------------------------------------- remote participants (inbound) */

function fiberOf(el: Element) {
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    return key ? (el as any)[key] : null;
}

/**
 * Work out which participant a media element belongs to.
 *
 * The <video> elements are created imperatively by the media engine and carry no React
 * fiber of their own, so the fiber walk has to start at the parent — but the enclosing
 * tile also tags itself with the user's id, which is both cheaper and more reliable.
 */
function resolveOwner(el: Element): Owner | null {
    const tile = el.closest("[data-selenium-video-tile]");
    const tileId = tile?.getAttribute("data-selenium-video-tile");
    if (tileId && /^\d{17,20}$/.test(tileId)) {
        // A camera and a Go Live from the same person share one tile id, so they need
        // separating or they collapse into a single NDI source. Camera tiles render
        // inside a previewWrapper_*; Go Live tiles use a videoContainer_* instead.
        // Class hashes change between Discord builds, hence the prefix match.
        const camera = el.closest('[class*="previewWrapper_"]');
        const stream = el.closest('[class*="videoContainer_"]');
        if (!camera && !stream) {
            console.warn(`[Discord-NDI] tile ${tileId} matched neither wrapper — `
                + "Discord may have renamed them; treating as camera.");
        }
        return { userId: tileId, screenshare: !!stream && !camera };
    }

    // Fallback: the fiber walk, starting one level up since the element itself has none.
    let fiber = fiberOf(el) ?? fiberOf(el.parentElement ?? el);

    for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props) continue;

        const streamKey = props.streamKey ?? props.stream?.streamKey;
        if (typeof streamKey === "string") {
            const userId = streamKey.split(":").pop();
            if (userId && /^\d+$/.test(userId)) return { userId, screenshare: true };
        }

        const userId = props.userId ?? props.user?.id ?? props.participant?.user?.id;
        if (typeof userId === "string" && /^\d+$/.test(userId)) return { userId, screenshare: false };
    }

    return null;
}

async function onSrcObject(el: HTMLMediaElement, stream: MediaStream | null) {
    if (!wire || !stream) return;

    // The element is usually attached to a fiber a tick after srcObject is set.
    let owner = resolveOwner(el);
    for (let i = 0; !owner && i < FIBER_RETRIES; i++) {
        await new Promise(res => setTimeout(res, FIBER_RETRY_MS));
        owner = resolveOwner(el);
    }
    if (!owner) return; // local preview, sound effects, or an unmapped element

    // ponytail: video only for now. Audio needs its own owner mapping and is not
    // reachable at all on the native client, so it is not worth carrying yet.
    const tracks = stream.getVideoTracks();
    const key = sourceKey(owner);

    // Retire whatever this element was publishing before adopting the new track.
    const previous = bound.get(el);
    if (previous) {
        for (const track of previous.tracks) {
            if (!tracks.includes(track)) detach(previous.key, track);
        }
    }
    bound.set(el, { key, tracks });

    for (const track of tracks) attach(owner, track);
}

/** Catch participants already on screen when the plugin was toggled on. */
function sweep() {
    for (const el of document.querySelectorAll("video, audio")) {
        const media = el as HTMLMediaElement;
        if (media.srcObject instanceof MediaStream) void onSrcObject(media, media.srcObject);
    }
}

/* ------------------------------------------------------- yourself (outbound) */

function selfOwner(track: MediaStreamTrack): Owner | null {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return null;
    // getDisplayMedia tracks report a displaySurface; camera tracks do not.
    const screenshare = track.kind === "video" && "displaySurface" in track.getSettings();
    return { userId, screenshare };
}

function attachOutbound(track: MediaStreamTrack | null | undefined) {
    if (!captureSelf || track?.kind !== "video" || seenOutbound.has(track)) return;
    seenOutbound.add(track);

    const owner = selfOwner(track);
    if (owner) attach(owner, track);
}

/* ------------------------------------------------------------ diagnostics */

/**
 * Report what is actually in the DOM, so a client that publishes nothing can be told
 * apart from a client whose media is simply not in JS. Runs until it finds something
 * or gives up, and lands in Discord's renderer_js.log.
 */
const lastLogged = new Map<string, string>();

/** Log only on change, so diagnostics can run for the whole session without spamming. */
function logOnce(tag: string, key: string, payload: unknown) {
    const line = JSON.stringify(payload);
    if (lastLogged.get(tag + key) === line) return;
    lastLogged.set(tag + key, line);
    console.log(`[Discord-NDI][${tag}] ${line}`);
}

function diagnose() {
    const media = [...document.querySelectorAll("video, audio")] as HTMLMediaElement[];

    for (const el of media) {
        const stream = el.srcObject as MediaStream | null;
        const track = stream?.getVideoTracks()[0];
        if (!track) continue;

        // Discord rotates and mirrors at render time rather than in the track, so the
        // orientation lives outside the frames we tap. Record where it does live, plus
        // the tile classes, which should also tell a Go Live tile from a camera tile.
        const boxes: any[] = [];
        for (let n: HTMLElement | null = el, d = 0; n && d < 5; n = n.parentElement, d++) {
            const cs = getComputedStyle(n);
            boxes.push({
                d,
                cls: n.className,
                tile: n.getAttribute?.("data-selenium-video-tile") ?? null,
                transform: cs.transform,
                rotate: (cs as any).rotate,
                objectFit: cs.objectFit
            });
        }

        // A person's camera and their Go Live land on the same userId tile, so something
        // else has to tell them apart. Dump every attribute on the tile and its wrapper.
        const tile = el.closest("[data-selenium-video-tile]");
        const tileAttrs: Record<string, string> = {};
        if (tile) for (const a of tile.attributes) tileAttrs[a.name] = a.value;
        const parentAttrs: Record<string, string> = {};
        if (tile?.parentElement) for (const a of tile.parentElement.attributes) parentAttrs[a.name] = a.value;

        // Key on the track, not the user: keying on the user is what made the camera and
        // the Go Live tile overwrite each other in the first place.
        logOnce("tile", track.id, {
            tileAttrs,
            parentAttrs,
            owner: resolveOwner(el),
            deviceId: track.getSettings().deviceId,
            size: [(el as HTMLVideoElement).videoWidth, (el as HTMLVideoElement).videoHeight],
            // Badges and labels inside the tile should say which one is the stream.
            markup: tile?.outerHTML.replace(/<video[^>]*>/g, "<video/>").slice(0, 600) ?? null
        });

        logOnce("orient", track.id, {
            owner: resolveOwner(el),
            video: [(el as HTMLVideoElement).videoWidth, (el as HTMLVideoElement).videoHeight],
            settings: track.getSettings(),
            boxes
        });
    }

    logOnce("probe", "", { sources: sources.size, media: media.length });
}

/**
 * Re-run discovery on a timer. The srcObject patch catches most changes immediately, but
 * Discord can also swap a participant's track by mutating the existing MediaStream, which
 * fires no setter at all — this reconcile catches those regardless of mechanism. It walks
 * a handful of elements, so the cost is noise.
 */
function startReconciling() {
    const timer = setInterval(() => {
        sweep();
        diagnose();
    }, RECONCILE_MS);
    undo.push(() => clearInterval(timer));
}

/* --------------------------------------------------------------- patching */

/** Replace a prototype method, registering the undo. Never swallows the original's result. */
function patch<T extends object>(proto: T, name: keyof T & string, wrap: (original: any) => any) {
    const original = (proto as any)[name];
    (proto as any)[name] = wrap(original);
    undo.push(() => { (proto as any)[name] = original; });
}

export function startTapping(withSelf = true) {
    if (wire) return;

    wire = new Wire();
    captureSelf = withSelf;
    wire.connect();

    // --- remote: every attach of a stream to a media element
    const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject")!;
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        ...srcObject,
        set(this: HTMLMediaElement, value: MediaStream | null) {
            srcObject.set!.call(this, value);
            // Bookkeeping must never be able to break playback.
            onSrcObject(this, value).catch(err => console.error("[Discord-NDI] tap failed", err));
        }
    });
    undo.push(() => Object.defineProperty(HTMLMediaElement.prototype, "srcObject", srcObject));

    // --- self: mic on join, and camera/screen share when they start
    patch(RTCPeerConnection.prototype, "addTrack", original => function (this: RTCPeerConnection, ...args: any[]) {
        const sender = original.apply(this, args);
        attachOutbound(args[0]);
        return sender;
    });

    // Discord swaps camera <-> screen share on an existing sender rather than renegotiating.
    patch(RTCRtpSender.prototype, "replaceTrack", original => function (this: RTCRtpSender, track: MediaStreamTrack | null) {
        attachOutbound(track);
        return original.call(this, track);
    });

    // Enabling mid-call misses the addTrack calls that already happened. Discord polls
    // getSenders constantly for stats, so harvesting here picks them up within a second.
    patch(RTCPeerConnection.prototype, "getSenders", original => function (this: RTCPeerConnection) {
        const senders = original.call(this);
        for (const sender of senders) attachOutbound(sender.track);
        return senders;
    });

    sweep();
    startReconciling();
}

export function stopTapping() {
    while (undo.length) undo.pop()!();

    for (const source of sources.values()) source.abort.abort();
    sources.clear();

    wire?.destroy();
    wire = null;
}

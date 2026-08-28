/*
 * NDI output. Receives per-user frames from the injected payload over a local WebSocket
 * and republishes each participant as their own NDI source.
 */

import { decode, type Frame, TYPE } from "./protocol";

// grandiose is a real N-API addon (its binary references only napi_* symbols), so it
// loads under Bun and Electrobun alike. Optional so the app still runs without NDI.
let grandiose: any = null;
let loadError: string | null = null;

export async function loadGrandiose(dry = false) {
    if (dry) return;
    try {
        grandiose = await import("grandiose");
    } catch (e) {
        loadError = (e as Error).message;
        console.error(`grandiose failed to load (${loadError}); running dry, no NDI output`);
    }
}

/** NDI timecodes are in 100ns units; wire timestamps are microseconds. */
const timecode = (micros: number) => BigInt(Math.round(micros * 10));

export class Source {
    frames = 0;
    private sender: any = null;
    private closed = false;

    constructor(readonly name: string) {
        // send() resolves to the sender rather than returning it — frames arriving in the
        // meantime are dropped, which takes a millisecond or two.
        grandiose?.send({ name, clockVideo: false, clockAudio: false })
            .then((sender: any) => {
                if (this.closed) return void sender.destroy();
                this.sender = sender;
            })
            .catch((e: Error) => console.error(`sender "${name}" failed: ${e.message}`));
    }

    /** True once the NDI sender exists — i.e. frames are really going out. */
    get live() { return this.sender !== null; }

    video({ a: width, b: height, timestamp, payload }: Frame) {
        this.frames++;
        this.sender?.video({
            type: "video",
            xres: width,
            yres: height,
            // ponytail: fixed 30fps. Receivers sync off timecode, so this is cosmetic.
            frameRateN: 30,
            frameRateD: 1,
            pictureAspectRatio: width / height,
            frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
            fourCC: grandiose.FOURCC_BGRA,
            lineStrideBytes: width * 4,
            timecode: timecode(timestamp),
            data: payload
        });
    }

    audio({ a: sampleRate, b: channels, timestamp, payload }: Frame) {
        this.frames++;
        const channelStrideBytes = payload.length / channels;
        this.sender?.audio({
            type: "audio",
            sampleRate,
            noChannels: channels,
            noSamples: channelStrideBytes / 4, // f32 planar
            channelStrideBytes,
            // Required. Omitting it hands the native side an uninitialised FourCC and
            // segfaults the process. The payload is f32 planar, so FLTp.
            fourCC: grandiose.FOURCC_FLTp,
            timecode: timecode(timestamp),
            data: payload
        });
    }

    close() {
        this.closed = true;
        this.sender?.destroy?.();
        this.sender = null;
    }
}

/** Live sources, shared so the UI can report them. One Discord means one publisher. */
export const sources = new Map<string, Source>();

export function status() {
    return {
        ndi: !!grandiose,
        error: loadError,
        sources: [...sources.entries()].map(([key, s]) => ({ key, name: s.name, frames: s.frames, live: s.live }))
    };
}

export function handle(raw: Buffer | Uint8Array | string) {
    if (typeof raw === "string") return console.error("bad frame: expected binary");
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

    let msg: Frame;
    try {
        msg = decode(buf);
    } catch (e) {
        return console.error("bad frame:", (e as Error).message);
    }

    if (msg.type === TYPE.HELLO) {
        const { name } = JSON.parse(msg.payload.toString("utf8"));
        sources.get(msg.id)?.close();
        sources.set(msg.id, new Source(name));
        return console.log(`+ ${name}`);
    }

    if (msg.type === TYPE.BYE) {
        const src = sources.get(msg.id);
        if (src) console.log(`- ${src.name} (${src.frames} frames)`);
        src?.close();
        sources.delete(msg.id);
        return;
    }

    // A frame for an id we never saw a hello for is dropped, not fatal.
    const src = sources.get(msg.id);
    if (!src) return;
    if (msg.type === TYPE.VIDEO) src.video(msg);
    else if (msg.type === TYPE.AUDIO) src.audio(msg);
}

export function closeAll() {
    for (const src of sources.values()) src.close();
    sources.clear();
}

export function serve(port: number) {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("websocket only\n", { status: 426 })),
        websocket: {
            // Frames are uncompressed video; compressing would burn CPU and add latency.
            perMessageDeflate: false,
            open: () => console.log("payload connected"),
            message: (_ws, raw) => handle(raw),
            close: () => {
                closeAll();
                console.log("payload disconnected");
            }
        }
    });

    console.log(`ndi ingest on ws://127.0.0.1:${port}${grandiose ? "" : " (dry, no NDI output)"}`);
    return server;
}

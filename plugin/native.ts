/*
 * Runs in Discord's Electron main process, where Node is available.
 *
 * grandiose is a genuine N-API addon — its binary references only napi_* symbols, no V8
 * or node internals — so it is ABI-stable and loads in Electron without a rebuild. That
 * is why the NDI senders can live in-process here instead of in a separate sidecar.
 *
 * Vencord marks bare imports external, so this require survives bundling and resolves
 * from the Vencord checkout's node_modules.
 */

import type { IpcMainInvokeEvent } from "electron";

let grandiose: any = null;
let loadError: string | null = null;
try {
    grandiose = require("grandiose");
} catch (e) {
    loadError = (e as Error).message;
}

/** NDI timecodes are in 100ns units; frame timestamps arrive as microseconds. */
const timecode = (micros: number) => BigInt(Math.round(micros * 10));

const senders = new Map<string, any>();
/** Sources whose sender is still being created, so frames in the gap are dropped, not queued. */
const opening = new Set<string>();

export async function status(_: IpcMainInvokeEvent) {
    return { ok: !!grandiose, error: loadError, sources: senders.size };
}

export async function open(_: IpcMainInvokeEvent, key: string, name: string) {
    if (!grandiose || senders.has(key) || opening.has(key)) return;

    opening.add(key);
    try {
        const sender = await grandiose.send({ name, clockVideo: false, clockAudio: false });
        // close() may have run while we were awaiting; don't leak an orphan sender.
        if (!opening.delete(key)) return void sender.destroy();
        senders.set(key, sender);
    } catch (e) {
        opening.delete(key);
        console.error(`[Discord-NDI] sender "${name}" failed:`, (e as Error).message);
    }
}

export async function video(
    _: IpcMainInvokeEvent, key: string,
    width: number, height: number, timestamp: number, data: Uint8Array
) {
    const sender = senders.get(key);
    if (!sender) return;

    await sender.video({
        type: "video",
        xres: width,
        yres: height,
        // ponytail: fixed 30fps. Receivers sync off timecode, so this is cosmetic
        // metadata; plumb the real rate through open() if something ever cares.
        frameRateN: 30,
        frameRateD: 1,
        pictureAspectRatio: width / height,
        frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE,
        fourCC: grandiose.FOURCC_BGRA,
        lineStrideBytes: width * 4,
        timecode: timecode(timestamp),
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    });
}

export async function audio(
    _: IpcMainInvokeEvent, key: string,
    sampleRate: number, channels: number, timestamp: number, data: Uint8Array
) {
    const sender = senders.get(key);
    if (!sender) return;

    const channelStrideBytes = data.byteLength / channels;
    await sender.audio({
        type: "audio",
        sampleRate,
        noChannels: channels,
        noSamples: channelStrideBytes / 4, // f32 planar
        channelStrideBytes,
        // Required. Omitting it hands the native side an uninitialised FourCC and
        // segfaults the process. The payload is f32 planar, so FLTp.
        fourCC: grandiose.FOURCC_FLTp,
        timecode: timecode(timestamp),
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    });
}

export async function close(_: IpcMainInvokeEvent, key: string) {
    opening.delete(key); // cancels an in-flight open()
    const sender = senders.get(key);
    if (!sender) return;
    senders.delete(key);
    await sender.destroy();
}

/** Called when you leave the call, and when the plugin stops. */
export async function closeAll(_: IpcMainInvokeEvent) {
    opening.clear();
    const all = [...senders.values()];
    senders.clear();
    await Promise.all(all.map(s => s.destroy().catch(() => { })));
}

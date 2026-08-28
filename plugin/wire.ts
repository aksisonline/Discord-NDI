/*
 * Discord-NDI: frame extraction, and the renderer half of the pipe to native.ts.
 *
 * There is no socket and no sidecar — frames go straight to the Electron main process,
 * which owns the NDI senders.
 */

import type { PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.DiscordNdi as PluginNative<typeof import("./native")>;

export class Wire {
    private live = new Set<string>();
    /** Keys with a frame already in flight, so a slow sender drops frames instead of queueing. */
    private busy = new Set<string>();
    private closed = false;

    async destroy() {
        this.closed = true;
        this.live.clear();
        this.busy.clear();
        await Native.closeAll();
    }

    hello(key: string, name: string) {
        if (this.closed || this.live.has(key)) return;
        this.live.add(key);
        Native.open(key, name);
    }

    bye(key: string) {
        if (!this.live.delete(key)) return;
        this.busy.delete(key);
        Native.close(key);
    }

    /**
     * Send one frame, dropping it if the previous one for this source has not landed.
     * Dropping video is the right call under load; queueing would grow latency forever.
     */
    private async send(key: string, call: () => Promise<void>) {
        if (this.closed || !this.live.has(key) || this.busy.has(key)) return;
        this.busy.add(key);
        try {
            await call();
        } catch (err) {
            console.error(`[Discord-NDI] send failed for ${key}`, err);
        } finally {
            this.busy.delete(key);
        }
    }

    video(key: string, width: number, height: number, ts: number, payload: Uint8Array) {
        return this.send(key, () => Native.video(key, width, height, ts, payload));
    }

    audio(key: string, sampleRate: number, channels: number, ts: number, payload: Uint8Array) {
        return this.send(key, () => Native.audio(key, sampleRate, channels, ts, payload));
    }
}

/**
 * Pump a track into the wire until it ends or `signal` aborts.
 * MediaStreamTrackProcessor hands us decoded frames directly — no canvas, no rVFC.
 */
export async function pump(wire: Wire, key: string, track: MediaStreamTrack, signal: AbortSignal) {
    // Clone so Discord's own teardown of the original doesn't kill our read, and so
    // stopping ours doesn't disturb playback.
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
                if (clone.kind === "video") await sendVideo(wire, key, value);
                else await sendAudio(wire, key, value);
            } finally {
                // A leaked VideoFrame stalls the whole pipeline within seconds.
                value.close();
            }
        }
    } catch (err) {
        if (!signal.aborted) console.error(`[Discord-NDI] pump ${key} died`, err);
    } finally {
        clone.stop();
    }
}

async function sendVideo(wire: Wire, key: string, frame: any) {
    // BGRA is what NDI wants, and VideoFrame.copyTo does the conversion for us.
    const buf = new Uint8Array(frame.allocationSize({ format: "BGRA" }));
    await frame.copyTo(buf, { format: "BGRA" });
    await wire.video(key, frame.codedWidth, frame.codedHeight, frame.timestamp, buf);
}

async function sendAudio(wire: Wire, key: string, data: any) {
    // f32-planar is NDI's native audio layout, so this is a straight copy.
    const channels = data.numberOfChannels;
    const planeBytes = data.allocationSize({ planeIndex: 0, format: "f32-planar" });
    const buf = new Uint8Array(planeBytes * channels);
    for (let c = 0; c < channels; c++) {
        data.copyTo(buf.subarray(c * planeBytes, (c + 1) * planeBytes), { planeIndex: c, format: "f32-planar" });
    }
    await wire.audio(key, data.sampleRate, channels, data.timestamp, buf);
}

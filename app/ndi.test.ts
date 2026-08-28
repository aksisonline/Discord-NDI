/*
 * The dry-run tests never touch grandiose, so every frame-shape mistake sailed
 * through them: a missing audio fourCC segfaults the whole process, and send()
 * resolving to a promise meant `sender?.video()` silently dropped everything.
 * These tests push real frames through a real NDI sender.
 *
 * Skipped when grandiose is unavailable (no NDI runtime, unsupported platform).
 */

import { expect, test } from "bun:test";

import { closeAll, handle, loadGrandiose, Source, sources } from "./ndi";
import { encode, TYPE } from "./protocol";

let grandiose: any = null;
try {
    grandiose = await import("grandiose");
    // index.ts only loads grandiose under import.meta.main, so without this the
    // Sources below would have no sender and these tests would pass vacuously.
    await loadGrandiose();
} catch { /* left null — every test below skips */ }

const withNdi = test.skipIf(!grandiose);

withNdi("a real sender accepts video and audio frames", async () => {
    const src = new Source("test-key", "Discord – Test");
    // send() is async; frames before it resolves are dropped by design.
    await Bun.sleep(100);
    expect(src.live).toBe(true); // guards against this test passing on the dry path

    const [w, h] = [320, 240];
    src.video({ type: TYPE.VIDEO, screenshare: false, a: w, b: h, timestamp: 1e6, id: "1", payload: Buffer.alloc(w * h * 4, 0x7f) });

    const [channels, samples] = [2, 480];
    src.audio({ type: TYPE.AUDIO, screenshare: false, a: 48000, b: channels, timestamp: 1e6, id: "1", payload: Buffer.alloc(samples * channels * 4) });

    await Bun.sleep(100);
    expect(src.frames).toBe(2);
    src.close();
});

withNdi("frames survive the full decode path", async () => {
    closeAll();
    const id = "424242";
    handle(encode({ type: TYPE.HELLO, id, payload: Buffer.from(JSON.stringify({ name: "Discord – Path" })) }));
    await Bun.sleep(100);
    expect(sources.get(id)!.live).toBe(true);

    const [w, h] = [64, 48];
    handle(encode({ type: TYPE.VIDEO, id, a: w, b: h, timestamp: 2e6, payload: Buffer.alloc(w * h * 4) }));
    handle(encode({ type: TYPE.AUDIO, id, a: 48000, b: 2, timestamp: 2e6, payload: Buffer.alloc(480 * 2 * 4) }));

    await Bun.sleep(100);
    expect(sources.get(id)!.frames).toBe(2);
    handle(encode({ type: TYPE.BYE, id }));
    expect(sources.size).toBe(0);
});

withNdi("the hardcoded frame constants match grandiose's own", () => {
    const g = grandiose.default ?? grandiose;
    expect(g.FORMAT_TYPE_PROGRESSIVE).toBe(1);
    expect(typeof g.FOURCC_BGRA).toBe("number");
    expect(typeof g.FOURCC_FLTp).toBe("number");
});

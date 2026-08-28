import { expect, test } from "bun:test";

import { closeAll, handle, sources } from "./ndi";
import { decode, encode, HEADER, TYPE } from "./protocol";

test("header round-trips exactly", () => {
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const got = decode(encode({
        type: TYPE.VIDEO, screenshare: true, a: 1920, b: 1080, timestamp: 1234567.5, id: "12345", payload
    }));

    expect(got).toMatchObject({
        type: TYPE.VIDEO, screenshare: true, a: 1920, b: 1080, timestamp: 1234567.5, id: "12345"
    });
    expect(got.payload).toEqual(payload);
});

test("bye frames carry no payload", () => {
    expect(decode(encode({ type: TYPE.BYE, id: "9" })).payload.length).toBe(0);
});

test("idLen counts bytes, not code units", () => {
    expect(decode(encode({ type: TYPE.BYE, id: "u☃" })).id).toBe("u☃");
});

test("truncated frames throw instead of returning short data", () => {
    const full = encode({ type: TYPE.VIDEO, id: "1", payload: Buffer.alloc(8) });
    expect(() => decode(full.subarray(0, full.length - 1))).toThrow(/truncated/);
    expect(() => decode(full.subarray(0, HEADER - 1))).toThrow(/short frame/);
});

test("frames for an unannounced id are dropped, not fatal", () => {
    closeAll();
    handle(encode({ type: TYPE.VIDEO, id: "nope", a: 2, b: 2, payload: Buffer.alloc(16) }));
    expect(sources.size).toBe(0);
});

test("malformed input does not throw out of handle()", () => {
    closeAll();
    handle(Buffer.alloc(3));
    handle("not binary");
    expect(sources.size).toBe(0);
});

test("hello/video/audio/bye over a live socket", async () => {
    const { serve } = await import("./ndi");
    const server = serve(19191);

    const ws = new WebSocket("ws://127.0.0.1:19191");
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    const id = "424242";
    const [w, h] = [320, 240];
    ws.send(encode({ type: TYPE.HELLO, id, payload: Buffer.from(JSON.stringify({ name: "Discord – Test" })) }));
    ws.send(encode({ type: TYPE.VIDEO, id, a: w, b: h, timestamp: 1e6, payload: Buffer.alloc(w * h * 4, 0x7f) }));
    ws.send(encode({ type: TYPE.AUDIO, id, a: 48000, b: 2, timestamp: 1e6, payload: Buffer.alloc(480 * 2 * 4) }));
    ws.send(encode({ type: TYPE.BYE, id }));

    await Bun.sleep(250);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    server.stop(true);
});

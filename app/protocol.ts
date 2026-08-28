/*
 * Wire format (little-endian), plugin -> bridge.
 * The encoder half lives in plugin/wire.ts — keep the two in step.
 *
 *   0  u8   type    1=video 2=audio 3=hello 4=bye
 *   1  u8   flags   bit0 = screenshare
 *   2  u16  idLen
 *   4  u32  width    | sampleRate
 *   8  u32  height   | channels
 *  12  u32  payloadLen
 *  16  f64  timestamp, microseconds
 *  24  utf8 id[idLen]
 *       payload[payloadLen]
 *
 * video payload: BGRA, tightly packed, stride = width*4
 * audio payload: f32 planar, channelStride = payloadLen/channels
 */

export const HEADER = 24;

export const TYPE = { VIDEO: 1, AUDIO: 2, HELLO: 3, BYE: 4 } as const;

export interface Frame {
    type: number;
    screenshare: boolean;
    /** width (video) or sampleRate (audio) */
    a: number;
    /** height (video) or channels (audio) */
    b: number;
    timestamp: number;
    id: string;
    payload: Buffer;
}

export function decode(buf: Buffer): Frame {
    if (buf.length < HEADER) throw new Error(`short frame: ${buf.length} bytes`);

    const idLen = buf.readUInt16LE(2);
    const payloadLen = buf.readUInt32LE(12);
    const end = HEADER + idLen + payloadLen;
    if (buf.length < end) throw new Error(`truncated frame: have ${buf.length}, need ${end}`);

    return {
        type: buf.readUInt8(0),
        screenshare: (buf.readUInt8(1) & 1) === 1,
        a: buf.readUInt32LE(4),
        b: buf.readUInt32LE(8),
        timestamp: buf.readDoubleLE(16),
        id: buf.toString("utf8", HEADER, HEADER + idLen),
        payload: buf.subarray(HEADER + idLen, end)
    };
}

/** Only the tests encode; the real encoder is in the plugin. */
export function encode(frame: Partial<Frame>): Buffer {
    const { type = 0, screenshare = false, a = 0, b = 0, timestamp = 0, id = "" } = frame;
    const payload = frame.payload ?? Buffer.alloc(0);
    const idBuf = Buffer.from(id, "utf8");

    const buf = Buffer.alloc(HEADER + idBuf.length + payload.length);
    buf.writeUInt8(type, 0);
    buf.writeUInt8(screenshare ? 1 : 0, 1);
    buf.writeUInt16LE(idBuf.length, 2);
    buf.writeUInt32LE(a, 4);
    buf.writeUInt32LE(b, 8);
    buf.writeUInt32LE(payload.length, 12);
    buf.writeDoubleLE(timestamp, 16);
    idBuf.copy(buf, HEADER);
    payload.copy(buf, HEADER + idBuf.length);
    return buf;
}

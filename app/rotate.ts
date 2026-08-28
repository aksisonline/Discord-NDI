/*
 * Rotate a raw BGRA video frame in 90-degree steps.
 *
 * Applied once in ndi.ts, upstream of both the NDI sender and any browser viewer, so the
 * two outputs can never disagree with each other the way an NDI-side vs CSS-side rotation
 * would. payload.ts stays canvas-free; this is a plain typed-array transpose instead.
 */

export type Rotation = 0 | 90 | 180 | 270;

const BPP = 4;

/**
 * Clockwise rotation. Derived from the standard image-rotation mapping
 * (x,y) -> (H-1-y, x) for 90 deg and its counter-clockwise inverse for 270 deg, then
 * inverted to a dst-driven loop since we iterate destination pixels. Verified against
 * hand-worked examples in rotate.test.ts, not just derived on paper.
 */
export function rotateBGRA(src: Uint8Array, width: number, height: number, rotation: Rotation) {
    if (rotation === 0) return { data: src, width, height };

    if (rotation === 180) {
        const dst = new Uint8Array(src.length);
        const total = width * height;
        for (let i = 0; i < total; i++) {
            const s = i * BPP;
            const d = (total - 1 - i) * BPP;
            dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
        }
        return { data: dst, width, height };
    }

    // 90 and 270 swap width/height.
    const newWidth = height;
    const newHeight = width;
    const dst = new Uint8Array(src.length);

    for (let r = 0; r < newHeight; r++) {
        for (let c = 0; c < newWidth; c++) {
            // dst row r, col c -> source (sx, sy). See derivation in the header comment.
            const sx = rotation === 90 ? r : width - 1 - r;
            const sy = rotation === 90 ? height - 1 - c : c;
            const s = (sy * width + sx) * BPP;
            const d = (r * newWidth + c) * BPP;
            dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
        }
    }

    return { data: dst, width: newWidth, height: newHeight };
}

/** BGRA -> RGBA for canvas ImageData, which only understands RGBA byte order. */
export function bgraToRgba(src: Uint8Array) {
    const dst = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += BPP) {
        dst[i] = src[i + 2];     // R <- B
        dst[i + 1] = src[i + 1]; // G
        dst[i + 2] = src[i];     // B <- R
        dst[i + 3] = src[i + 3]; // A
    }
    return dst;
}

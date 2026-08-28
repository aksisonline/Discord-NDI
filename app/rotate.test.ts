import { expect, test } from "bun:test";

import { bgraToRgba, rotateBGRA } from "./rotate";

// 2x2 BGRA image, pixels labeled 1..4 for a legible layout:
//   1 2
//   3 4
function grid2x2() {
    const px = (n: number) => [n, n, n, 255];
    return new Uint8Array([...px(1), ...px(2), ...px(3), ...px(4)]);
}

test("0 degrees is a no-op", () => {
    const src = grid2x2();
    const { data, width, height } = rotateBGRA(src, 2, 2, 0);
    expect(data).toBe(src); // literally the same buffer, not just equal
    expect([width, height]).toEqual([2, 2]);
});

test("90 degrees matches the textbook clockwise rotation of a 2x2 grid", () => {
    // 1 2      3 1
    // 3 4  ->  4 2
    const { data, width, height } = rotateBGRA(grid2x2(), 2, 2, 90);
    expect([width, height]).toEqual([2, 2]);
    expect([data[0], data[4], data[8], data[12]]).toEqual([3, 1, 4, 2]);
});

test("270 degrees is the inverse of 90", () => {
    // 1 2      2 4
    // 3 4  ->  1 3
    const { data, width, height } = rotateBGRA(grid2x2(), 2, 2, 270);
    expect([width, height]).toEqual([2, 2]);
    expect([data[0], data[4], data[8], data[12]]).toEqual([2, 4, 1, 3]);
});

test("180 degrees reverses the pixel order", () => {
    const { data, width, height } = rotateBGRA(grid2x2(), 2, 2, 180);
    expect([width, height]).toEqual([2, 2]);
    expect([data[0], data[4], data[8], data[12]]).toEqual([4, 3, 2, 1]);
});

test("90/270 swap width and height on a non-square frame", () => {
    // A 2-wide, 1-tall strip: [A, B]. Rotating 90 CW puts A on top, B on bottom.
    const A = 10, B = 200;
    const strip = new Uint8Array([A, A, A, 255, B, B, B, 255]);

    const cw = rotateBGRA(strip, 2, 1, 90);
    expect([cw.width, cw.height]).toEqual([1, 2]);
    expect([cw.data[0], cw.data[4]]).toEqual([A, B]);

    const ccw = rotateBGRA(strip, 2, 1, 270);
    expect([ccw.width, ccw.height]).toEqual([1, 2]);
    expect([ccw.data[0], ccw.data[4]]).toEqual([B, A]);
});

test("bgraToRgba swaps the R and B bytes only", () => {
    const bgra = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 0]);
    expect(bgraToRgba(bgra)).toEqual(new Uint8Array([30, 20, 10, 255, 60, 50, 40, 0]));
});

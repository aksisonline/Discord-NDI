/*
 * Electrobun main process. Owns the NDI senders and the CDP attachment; the window is
 * only a control surface.
 */

import { BrowserWindow } from "electrobun/main";

import { Controller, ui } from "../../../../app/index";
import { loadGrandiose } from "../../../../app/ndi";


const PORT = 9191;
const DEBUG_PORT = 9222;
const UI_PORT = 9333;

await loadGrandiose();
const controller = new Controller(PORT, DEBUG_PORT);

// Serve the same UI the standalone app serves — this is what the window loads over http.
// Duplicating routes here (the previous approach) silently dropped /view/:key and
// /api/source/:key/* from the packaged app, making per-source controls no-ops.
ui(controller, UI_PORT);

new BrowserWindow({
    title: "Discord-NDI",
    url: `http://127.0.0.1:${UI_PORT}/`,
    frame: { width: 440, height: 560, x: 120, y: 120 },
});

process.on("exit", () => void controller.stop());

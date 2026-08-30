import { createServer } from "net";

/*
 * Electrobun main process. Owns the NDI senders and the CDP attachment; the window is
 * only a control surface.
 */

import { BrowserWindow, Updater } from "electrobun/main";

import { findDiscord } from "../../../../app/cdp";
import { relaunchWithDebugging } from "../../../../app/discord";
import { Controller, ui } from "../../../../app/index";
import { loadGrandiose } from "../../../../app/ndi";


const PORT = await findPort(9191);
const DEBUG_PORT = 9222;
async function findPort(preferred: number): Promise<number> {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.on("error", () => {
            const fallback = createServer();
            fallback.listen(0, "127.0.0.1", () => {
                const port = (fallback.address() as any).port;
                fallback.close(() => resolve(port));
            });
        });
        srv.listen(preferred, "127.0.0.1", () => {
            srv.close(() => resolve(preferred));
        });
    });
}

const UI_PORT = await findPort(9333);

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

// Mirrors app/index.ts's CLI entrypoint: capture starts with the process, there is no
// manual master on/off. Without this the panel had no way to ever start at all once the
// toggle that used to call /api/start was removed.
if (!await findDiscord(DEBUG_PORT).catch(() => null)) {
    console.log("Discord is not exposing a debug port; relaunching it...");
    await relaunchWithDebugging(DEBUG_PORT);
}
await controller.start().catch(e => console.error("failed to start capture:", e));

process.on("exit", () => void controller.stop());

/**
 * Downloads eagerly but never installs itself: applyUpdate() swaps the running
 * install and relaunches, which would silently kill every NDI output and browser-view
 * socket mid-broadcast. Only auto-applies once nothing is actually being captured.
 */
async function checkForUpdate() {
    try {
        const info = await Updater.checkForUpdate();
        if (!info.updateAvailable) return;
        await Updater.downloadUpdate();
        if (controller.running && (await controller.status()).sources.length > 0) {
            console.log(`update ${info.version} downloaded; deferring install while capturing`);
            return;
        }
        console.log(`installing update ${info.version}`);
        await Updater.applyUpdate();
    } catch (e) {
        console.error("update check failed:", e);
    }
}

Updater.onStatusChange(entry => console.log(`[updater] ${entry.status}: ${entry.message}`));
void checkForUpdate();
setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);

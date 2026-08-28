/*
 * Electrobun main process. Owns the NDI senders and the CDP attachment; the window is
 * only a control surface.
 */

import { BrowserWindow } from "electrobun/main";

import { Controller } from "../../../../app/index";
import { loadGrandiose } from "../../../../app/ndi";
import { relaunchWithDebugging, waitForCdp } from "../../../../app/discord";

const PORT = 9191;
const DEBUG_PORT = 9222;
const UI_PORT = 9333;

await loadGrandiose();
const controller = new Controller(PORT, DEBUG_PORT);

// The window loads the panel over http rather than views://, so the same UI works both
// in the packaged app and in a browser during development.
Bun.serve({
    hostname: "127.0.0.1",
    port: UI_PORT,
    async fetch(req) {
        const { pathname } = new URL(req.url);

        if (pathname === "/api/status") {
            return Response.json({ ...controller.status(), discordReady: await waitForCdp(DEBUG_PORT, 1) });
        }

        if (pathname === "/api/relaunch-discord") {
            const ok = await relaunchWithDebugging(DEBUG_PORT);
            return ok
                ? Response.json(controller.status())
                : new Response("Discord did not come back with remote debugging enabled.", { status: 500 });
        }

        if (pathname === "/api/start" || pathname === "/api/stop") {
            try {
                pathname.endsWith("start") ? await controller.start() : await controller.stop();
                return Response.json(controller.status());
            } catch (e) {
                return new Response((e as Error).message, { status: 500 });
            }
        }

        return new Response(Bun.file(new URL("../views/mainview/index.html", import.meta.url).pathname));
    },
});

new BrowserWindow({
    title: "Discord-NDI",
    url: `http://127.0.0.1:${UI_PORT}/`,
    frame: { width: 440, height: 560, x: 120, y: 120 },
});

process.on("exit", () => void controller.stop());

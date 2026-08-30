#!/usr/bin/env bun
/*
 * Discord-NDI — publishes each participant in your Discord call as its own NDI source.
 *
 *   bun run app/index.ts [--port 9191] [--debug-port 9222] [--dry]
 *
 * Attaches to Discord over the Chrome DevTools Protocol and injects a tap into its
 * renderer. Nothing about Discord's install is modified, so turning it off really does
 * turn it off, and a Discord update cannot break the injection.
 */

import { parseArgs } from "util";

import { findDiscord, Session } from "./cdp";
import { relaunchWithDebugging } from "./discord";
import { closeAll, loadGrandiose, serve, setEnabled, setRotation, setViewerHooks, sources, status } from "./ndi";
import type { Rotation } from "./rotate";

/** Built once and cached; the payload is a self-contained bundle with the port baked in. */
export async function buildPayload(port: number) {
    const built = await Bun.build({
        entrypoints: [new URL("./payload.ts", import.meta.url).pathname],
        target: "browser",
        minify: false,
        define: { __PORT__: String(port) }
    });
    if (!built.success) throw new AggregateError(built.logs, "payload build failed");

    // Wrap in an IIFE. Re-injecting top-level declarations into a page that already has
    // them throws "Identifier 'Tap' has already been declared", which silently leaves the
    // previous tap running and makes a failed re-inject look like a working one.
    return `(() => {\n${await built.outputs[0].text()}\n})()`;
}

export class Controller {
    private session: Session | null = null;
    private server: ReturnType<typeof serve> | null = null;
    private script: string | null = null;
    /** Set by addScriptToEvaluateOnNewDocument, so it can be removed on stop. */
    private persistentScript: string | null = null;

    constructor(private port: number, private debugPort: number) { }

    get running() { return this.session !== null; }

    async start() {
        if (this.session) return;

        this.server ??= serve(this.port);
        this.script ??= await buildPayload(this.port);

        const target = await findDiscord(this.debugPort);
        if (!target) {
            throw new Error(
                `no Discord window found on CDP port ${this.debugPort}. `
                + "Discord must be started with --remote-debugging-port; use `relaunchDiscord()`."
            );
        }

        const session = await Session.attach(target.webSocketDebuggerUrl);
        await session.send("Runtime.enable");
        await session.send("Page.enable");

        // Inject now, and again on navigation — Discord soft-navigates constantly, and a
        // full reload would otherwise silently drop the tap.
        const { identifier } = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: this.script });
        this.persistentScript = identifier;

        // A throw here is silent unless checked, and a failed inject leaves any previous
        // tap running — which looks like success until the output is subtly stale.
        const result = await session.send("Runtime.evaluate", { expression: this.script, awaitPromise: true });
        if (result.exceptionDetails) {
            const { text, exception } = result.exceptionDetails;
            throw new Error(`payload threw on inject: ${exception?.description ?? text}`);
        }

        this.session = session;
        console.log("attached to Discord, tap injected");
    }

    async stop() {
        if (!this.session) return;
        const session = this.session;
        this.session = null;

        try {
            if (this.persistentScript) {
                await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.persistentScript });
            }
            // Tell the tap to shut itself down; it is idempotent if already gone.
            await session.send("Runtime.evaluate", { expression: "globalThis.__discordNdi?.stop()" });
        } catch { /* Discord may have quit under us — nothing to clean up there */ }

        this.persistentScript = null;
        session.close();
        closeAll();
        console.log("detached");
    }

    status() {
        return { running: this.running, port: this.port, debugPort: this.debugPort, ...status() };
    }
}

/** One <canvas> viewer page per source, no chrome — meant for OBS's Browser Source. */
function viewerPage(key: string) {
    return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden;height:100%}canvas{width:100vw;height:100vh;display:block}</style>
<canvas id="c"></canvas>
<script>
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const off = new OffscreenCanvas(1, 1);
const offCtx = off.getContext("2d");

function connect() {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/view/${key}/socket");
    ws.binaryType = "arraybuffer";
    ws.onmessage = ev => {
        const view = new DataView(ev.data);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        const rgba = new Uint8ClampedArray(ev.data, 8);

        if (off.width !== width || off.height !== height) {
            off.width = width;
            off.height = height;
        }
        offCtx.putImageData(new ImageData(rgba, width, height), 0, 0);

        // ponytail: stretch-fill, no letterboxing. Size the OBS Browser Source to match
        // the source's aspect ratio if that matters to you.
        if (canvas.width !== innerWidth || canvas.height !== innerHeight) {
            canvas.width = innerWidth;
            canvas.height = innerHeight;
        }
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    };
    ws.onclose = () => setTimeout(connect, 1000);
}
connect();
</script>`;
}

interface ViewerSocketData { viewerKey: string; }

/**
 * Local control panel: per-source rows, and the /view/:key browser outputs. Capture
 * starts automatically with the process — there is no manual master on/off.
 * `page` lets the packaged shell point at its copied view path instead of the default;
 * in the bundle the default `./ui.html` would resolve relative to the bundled main script.
 */
export function ui(controller: Controller, port: number, page?: string) {
    page ??= new URL("./ui.html", import.meta.url).pathname;
    /** key -> connected viewer sockets, for the "only render for someone watching" gate. */
    const viewers = new Map<string, Set<import("bun").ServerWebSocket<ViewerSocketData>>>();

    setViewerHooks({
        hasViewers: key => (viewers.get(key)?.size ?? 0) > 0,
        broadcast(key, width, height, rgba) {
            const sockets = viewers.get(key);
            if (!sockets?.size) return;
            const header = new Uint8Array(8);
            new DataView(header.buffer).setUint32(0, width, true);
            new DataView(header.buffer).setUint32(4, height, true);
            const frame = new Uint8Array(8 + rgba.length);
            frame.set(header);
            frame.set(rgba, 8);
            for (const ws of sockets) ws.send(frame);
        },
        closeViewers(key) {
            for (const ws of viewers.get(key) ?? []) ws.close();
            viewers.delete(key);
        }
    });

    const server = Bun.serve<ViewerSocketData>({
        hostname: "127.0.0.1",
        port,
        async fetch(req, server) {
            const { pathname } = new URL(req.url);

            if (pathname === "/api/status") return Response.json(controller.status());

            const enabledMatch = pathname.match(/^\/api\/source\/([^/]+)\/enabled$/);
            if (enabledMatch && req.method === "POST") {
                const { enabled } = await req.json();
                setEnabled(decodeURIComponent(enabledMatch[1]), !!enabled);
                return Response.json(controller.status());
            }

            const rotationMatch = pathname.match(/^\/api\/source\/([^/]+)\/rotation$/);
            if (rotationMatch && req.method === "POST") {
                const { rotation } = await req.json();
                if (![0, 90, 180, 270].includes(rotation)) return new Response("rotation must be 0/90/180/270", { status: 400 });
                setRotation(decodeURIComponent(rotationMatch[1]), rotation as Rotation);
                return Response.json(controller.status());
            }

            const viewMatch = pathname.match(/^\/view\/([^/]+)$/);
            if (viewMatch) {
                const key = decodeURIComponent(viewMatch[1]);
                const source = sources.get(key);
                // Matches the "fully torn down" off-state: no page for a source that
                // doesn't exist or was switched off, same as if the person had left.
                if (!source || !source.enabled) return new Response("source not available", { status: 404 });
                return new Response(viewerPage(key), { headers: { "content-type": "text/html" } });
            }

            const socketMatch = pathname.match(/^\/view\/([^/]+)\/socket$/);
            if (socketMatch) {
                const key = decodeURIComponent(socketMatch[1]);
                if (!sources.get(key)?.enabled) return new Response("source not available", { status: 404 });
                return server.upgrade(req, { data: { viewerKey: key } }) ? undefined : new Response("upgrade failed", { status: 500 });
            }

            return new Response(Bun.file(page));
        },
        websocket: {
            open(ws) {
                const key = ws.data.viewerKey;
                if (!viewers.has(key)) viewers.set(key, new Set());
                viewers.get(key)!.add(ws);
            },
            close(ws) {
                viewers.get(ws.data.viewerKey)?.delete(ws);
            },
            message() { /* viewers are receive-only */ }
        }
    });

    console.log(`control panel: http://127.0.0.1:${port}`);
    return server;
}

if (import.meta.main) {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            port: { type: "string", default: "9191" },
            "debug-port": { type: "string", default: "9222" },
            ui: { type: "string", default: "9333" },
            dry: { type: "boolean", default: false },
            headless: { type: "boolean", default: false }
        }
    });

    await loadGrandiose(values.dry);
    const controller = new Controller(Number(values.port), Number(values["debug-port"]));

    const debugPort = Number(values["debug-port"]);
    if (!await findDiscord(debugPort).catch(() => null)) {
        console.log("Discord is not exposing a debug port; relaunching it...");
        if (!await relaunchWithDebugging(debugPort)) {
            console.error("Discord did not come back with remote debugging enabled.");
            process.exit(1);
        }
    }

    if (!values.headless) ui(controller, Number(values.ui));
    await controller.start();

    let shuttingDown = false;
    async function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        await controller.stop();
        process.exit(0);
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown); // sent by e.g. Foundation's Process.terminate(), when run as a child

    // A packaged shell (the SwiftUI app) spawns this as a child process, but has no
    // portable way to guarantee a signal reaches it if the parent crashes outright
    // rather than quitting cleanly — an orphaned process would otherwise keep the
    // ports bound indefinitely. Polling ppid is the standard, dependency-free way to
    // detect that: it changes (usually to 1, launchd) the moment the parent is gone.
    const parentPid = process.ppid;
    setInterval(() => {
        if (process.ppid !== parentPid) {
            console.error("parent process gone; shutting down");
            void shutdown();
        }
    }, 2000);
}

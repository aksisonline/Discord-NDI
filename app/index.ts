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
import { relaunchWithDebugging, waitForCdp } from "./discord";
import { closeAll, loadGrandiose, serve, status } from "./ndi";

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

/** Local control panel: an on/off switch and whatever is currently publishing. */
export function ui(controller: Controller, port: number) {
    const page = new URL("./ui.html", import.meta.url).pathname;

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(req) {
            const { pathname } = new URL(req.url);

            if (pathname === "/api/status") return Response.json(controller.status());

            if (pathname === "/api/start" || pathname === "/api/stop") {
                try {
                    pathname.endsWith("start") ? await controller.start() : await controller.stop();
                    return Response.json(controller.status());
                } catch (e) {
                    // Surfaced in the UI; the usual cause is Discord running without the flag.
                    return new Response((e as Error).message, { status: 500 });
                }
            }

            return new Response(Bun.file(page));
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

    process.on("SIGINT", async () => {
        await controller.stop();
        process.exit(0);
    });
}

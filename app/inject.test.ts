/*
 * The payload is injected into a long-lived page, and re-injected whenever capture is
 * toggled. Bundled top-level declarations throw "Identifier 'Tap' has already been
 * declared" on the second inject — which silently leaves the *previous* tap running, so
 * the output looks fine while being stale. Hence the IIFE wrap, and hence this test.
 */

import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";

import { buildPayload } from "./index";

function fakePage() {
    const noop = () => { };
    const ctx: any = {
        console,
        setInterval: () => 0,
        clearInterval: noop,
        setTimeout: () => 0,
        clearTimeout: noop,
        TextEncoder,
        WeakMap,
        AbortController,
        document: { querySelectorAll: () => [] },
        WebSocket: class {
            static OPEN = 1;
            readyState = 0;
            binaryType = "";
            onopen: any; onclose: any; onerror: any;
            send = noop;
            close = noop;
        }
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    return createContext(ctx);
}

test("the payload can be injected twice into one page", async () => {
    const script = await buildPayload(9191);
    const page = fakePage();

    runInContext(script, page);
    // Without the IIFE wrap this throws SyntaxError on the redeclaration.
    expect(() => runInContext(script, page)).not.toThrow();
});

test("re-injection stops the previous tap rather than running two", async () => {
    const script = await buildPayload(9191);
    const page = fakePage();

    runInContext(script, page);
    const first = page.__discordNdi;
    runInContext(script, page);

    expect(page.__discordNdi).not.toBe(first);
    expect(first.stopped).toBe(true);
});

test("the configured port is baked into the bundle", async () => {
    // define substitutes the literal inside the template, so it reads `${12345}`.
    const script = await buildPayload(12345);
    expect(script).toContain("12345");
    expect(script).not.toContain("__PORT__");
});

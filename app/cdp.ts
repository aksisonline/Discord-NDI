/*
 * Minimal Chrome DevTools Protocol client.
 *
 * Discord is Electron, so launching it with --remote-debugging-port exposes its renderer
 * over CDP. That lets Discord-NDI inject its tap at runtime without patching app.asar,
 * which is what makes the on/off switch real and survives Discord updates.
 */

export interface Target {
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export async function targets(port: number): Promise<Target[]> {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    return res.json() as Promise<Target[]>;
}

/** The Discord app window, as opposed to workers or devtools pages. */
export async function findDiscord(port: number) {
    return (await targets(port)).find(t => t.type === "page" && t.url.startsWith("https://discord.com/"));
}

export class Session {
    private ws: WebSocket;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; }>();
    private handlers = new Map<string, (params: any) => void>();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.onmessage = ev => {
            const msg = JSON.parse(String(ev.data));
            if (msg.id) {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
            } else if (msg.method) {
                this.handlers.get(msg.method)?.(msg.params);
            }
        };
    }

    static async attach(url: string) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        return new Session(ws);
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    on(method: string, handler: (params: any) => void) {
        this.handlers.set(method, handler);
    }

    close() {
        this.ws.close();
    }
}

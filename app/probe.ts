// Dev helper: run an expression in Discord's renderer. bun run app/probe.ts <file>
import { findDiscord, Session } from "./cdp";

const expr = await Bun.file(Bun.argv[2]).text();
const target = await findDiscord(9222);
if (!target) throw new Error("no Discord target on 9222");
const session = await Session.attach(target.webSocketDebuggerUrl);
const r = await session.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails).slice(0, 500) : r.result.value);
session.close();

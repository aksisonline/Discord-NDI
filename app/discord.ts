/*
 * Finding, launching and relaunching the Discord client.
 *
 * Discord only opens its CDP port when started with --remote-debugging-port, and there is
 * no way to enable that on a running instance — so enabling capture on a Discord that was
 * started normally means restarting it.
 */

import { findDiscord } from "./cdp";

export const isWindows = process.platform === "win32";

/** Wait for Discord to expose a usable CDP target, or give up. */
export async function waitForCdp(debugPort: number, seconds = 30) {
    for (let i = 0; i < seconds; i++) {
        if (await findDiscord(debugPort).catch(() => null)) return true;
        await Bun.sleep(1000);
    }
    return false;
}

export async function isRunning() {
    const check = isWindows
        ? Bun.$`tasklist /FI ${"IMAGENAME eq Discord.exe"} /NH`.nothrow().quiet()
        : Bun.$`pgrep -x Discord`.nothrow().quiet();
    const result = await check;
    return isWindows ? result.stdout.toString().includes("Discord.exe") : result.exitCode === 0;
}

async function quit() {
    if (isWindows) {
        // Ask nicely first; Discord ignores it while a call is up, hence the forced pass.
        await Bun.$`taskkill /IM Discord.exe`.nothrow().quiet();
    } else {
        await Bun.$`osascript -e ${'quit app "Discord"'}`.nothrow().quiet();
    }

    for (let i = 0; i < 20; i++) {
        if (!await isRunning()) return true;
        await Bun.sleep(500);
    }

    if (isWindows) await Bun.$`taskkill /F /IM Discord.exe`.nothrow().quiet();
    else await Bun.$`pkill -x Discord`.nothrow().quiet();
    await Bun.sleep(1500);
    return !await isRunning();
}

async function launch(debugPort: number) {
    const flag = `--remote-debugging-port=${debugPort}`;

    if (!isWindows) {
        // `open -a` without -n reuses a running instance and drops the args, so Discord
        // must actually be gone by this point.
        await Bun.$`open -a Discord --args ${flag}`.quiet();
        return;
    }

    // On Windows, Discord.exe lives in a versioned app-* folder that changes with every
    // update. Update.exe is the stable entry point and forwards args to the current one.
    const updater = `${process.env["LOCALAPPDATA"]}\\Discord\\Update.exe`;
    if (await Bun.file(updater).exists()) {
        await Bun.$`${updater} --processStart Discord.exe --process-start-args ${flag}`.nothrow().quiet();
        return;
    }
    throw new Error(`Discord's updater was not found at ${updater}. Is Discord installed for this user?`);
}

/** Restart Discord with remote debugging on. Returns false if it never came back. */
export async function relaunchWithDebugging(debugPort: number) {
    await quit();
    await launch(debugPort);
    return waitForCdp(debugPort);
}

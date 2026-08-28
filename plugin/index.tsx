/*
 * DiscordNdi — publishes each voice-channel participant as their own NDI source.
 *
 * Installs into Vencord and Vesktop alike. Only Vesktop and the browser expose
 * remote media as JS MediaStreamTracks, though — the official desktop client runs a
 * native C++ media engine, so there is likely nothing there to tap. See README.
 *
 * Pairs with the bridge in this repo:  bun run bridge/index.ts
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { startTapping, stopTapping } from "./tap";

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Port the local NDI bridge listens on",
        default: 9191
    },
    captureSelf: {
        type: OptionType.BOOLEAN,
        description: "Also publish your own camera and screen share, as Discord transmits them",
        default: true
    }
});

export default definePlugin({
    name: "DiscordNdi",
    description: "Sends each voice participant's camera and screen share to a local NDI bridge as a separate source.",
    authors: [{ name: "aksisonline", id: 0n }],
    settings,

    start() {
        if (!("MediaStreamTrackProcessor" in window)) {
            return console.error("[Discord-NDI] MediaStreamTrackProcessor missing — this build cannot capture tracks.");
        }
        if (IS_DISCORD_DESKTOP) {
            // Better than silently publishing nothing and leaving you to wonder why.
            console.warn("[Discord-NDI] official Discord client detected: media runs in a native engine. "
                + "Watch for [Discord-NDI][probe] lines to see whether video is reachable here.");
        }
        startTapping(settings.store.captureSelf);
    },

    stop() {
        stopTapping();
    }
});

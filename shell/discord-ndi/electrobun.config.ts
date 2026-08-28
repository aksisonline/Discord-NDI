import type { ElectrobunConfig } from "electrobun";

export default {
    app: {
        name: "Discord-NDI",
        identifier: "sh.aks.discord-ndi",
        version: "0.1.0",
    },
    build: {
        // Bun, not the default Cottontail: the NDI binding is an N-API addon and needs a
        // Node-API host to load into.
        mainProcess: "bun",
        bun: {
            entrypoint: "src/bun/index.ts",
            // grandiose is a native .node; it must stay a runtime require and ship as a file.
            external: ["grandiose"],
        },
        views: {
            mainview: {
                entrypoint: "src/mainview/index.ts",
            },
        },
        copy: {
            "src/mainview/index.html": "views/mainview/index.html",
        },
        mac: { bundleCEF: false },
        win: { bundleCEF: false },
        linux: { bundleCEF: false },
    },
} satisfies ElectrobunConfig;

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
            minify: true,
        },
        copy: {
            // Single source of truth: the packaged UI is a straight copy of the
            // standalone app's panel, not a hand-maintained second file that can drift.
            // It lands next to the bundled main script so ui()'s default ./ui.html
            // path resolves the same way it does in the dev tree.
            "../../app/ui.html": "bun/ui.html",

            // grandiose is external (kept as a bare `require`, not bundled as JS), which
            // only stops esbuild from choking on the native addon — it does not put the
            // addon anywhere the packaged app can find it at runtime. These three copy
            // grandiose's whole runtime dependency chain (grandiose itself -> bindings
            // -> file-uri-to-path) to where the bundled main script's `require` walk
            // finds it: Contents/Resources/app/bun/index.js resolves node_modules by
            // walking up from its own directory, so it lands at .../app/bun/node_modules.
            //
            // app/'s bunfig.toml pins `linker = "hoisted"` specifically so these three
            // land as flat node_modules siblings — Bun's default isolated-store layout
            // nests transitive deps under version-hashed paths like
            // .bun/bindings@1.5.0/node_modules/bindings, which would make this copy list
            // brittle against every dependency bump. libndi.dylib ships inside
            // grandiose's own folder and loads via @loader_path, so it travels for free
            // as long as grandiose's directory structure is copied intact.
            "../../app/node_modules/grandiose": "bun/node_modules/grandiose",
            "../../app/node_modules/bindings": "bun/node_modules/bindings",
            "../../app/node_modules/file-uri-to-path": "bun/node_modules/file-uri-to-path",
        },
        mac: { bundleCEF: false },
        win: { bundleCEF: false },
        linux: { bundleCEF: false },
        // Icon assets land in assets/; field names below are the confirmed real ones
        // (checked against .hutch/devkit/api/config/ElectrobunConfig.ts). Uncomment
        // once a design exists.
        // mac:   { icons: "assets/App.iconset" },  // .iconset folder or .icon file
        // win:   { icon:  "assets/icon.ico" },     // .ico or .png
        // linux: { icon:  "assets/icon.png" },     // .png
    },
} satisfies ElectrobunConfig;

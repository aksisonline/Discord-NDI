import Foundation

/// Spawns and owns the existing Bun backend (app/index.ts) as a child process.
/// This is a native shell over that backend, not a reimplementation of it — the
/// CDP attach, renderer injection, and NDI sending all stay exactly as they are.
final class BackendProcess {
    let uiPort = 9333
    private var process: Process?

    /// A packaged build ships a plain `bun build` bundle (not `--compile`: Bun's
    /// compiled-binary runtime can't resolve grandiose's own nested `require("bindings")`
    /// at all, confirmed by testing directly — a real on-disk index.js is the only
    /// mechanism verified to work) at Resources/backend/index.js, run by a portable copy
    /// of the `bun` executable shipped right alongside it — see
    /// scripts/package-macos.sh. No system `bun` install and no dev checkout needed.
    private var bundledBackend: (bun: URL, indexJS: URL)? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let dir = resources.appendingPathComponent("backend")
        let bun = dir.appendingPathComponent("bun")
        let indexJS = dir.appendingPathComponent("index.js")
        guard FileManager.default.fileExists(atPath: bun.path),
              FileManager.default.fileExists(atPath: indexJS.path) else { return nil }
        return (bun, indexJS)
    }

    /// Dev fallback when unpackaged (`swift run`): `DISCORD_NDI_APP_DIR` overrides the
    /// app/ location; otherwise assumes a dev checkout, launched from the
    /// shell/discord-ndi-mac package directory (swift run's default cwd), where app/
    /// is two levels up.
    private var appEntrypoint: URL {
        if let override = ProcessInfo.processInfo.environment["DISCORD_NDI_APP_DIR"] {
            return URL(fileURLWithPath: override).appendingPathComponent("index.ts")
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("../../app/index.ts")
            .standardizedFileURL
    }

    func start() {
        guard process == nil else { return }

        let task = Process()
        // Not --headless: that flag skips the backend's whole HTTP server, API included.
        // This app only ignores ui.html and talks to the same /api/* JSON endpoints.
        if let (bun, indexJS) = bundledBackend {
            task.executableURL = bun
            task.arguments = ["run", indexJS.path, "--ui", String(uiPort)]
            // Real on-disk index.js next to a real on-disk payload.ts/node_modules — the
            // same layout already proven to work for the standalone app and Electrobun
            // shell, so import.meta.url-relative resolution just works unmodified.
            task.currentDirectoryURL = indexJS.deletingLastPathComponent()
        } else {
            let bun = ProcessInfo.processInfo.environment["BUN_PATH"] ?? "/usr/bin/env"
            if bun == "/usr/bin/env" {
                task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                task.arguments = ["bun", "run", appEntrypoint.path, "--ui", String(uiPort)]
            } else {
                task.executableURL = URL(fileURLWithPath: bun)
                task.arguments = ["run", appEntrypoint.path, "--ui", String(uiPort)]
            }
        }

        task.standardOutput = FileHandle.standardOutput
        task.standardError = FileHandle.standardError

        do {
            try task.run()
            process = task
        } catch {
            print("failed to launch backend: \(error)")
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }
}

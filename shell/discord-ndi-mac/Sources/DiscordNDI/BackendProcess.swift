import Foundation

/// Spawns and owns the existing Bun backend (app/index.ts) as a child process.
/// This is a native shell over that backend, not a reimplementation of it — the
/// CDP attach, renderer injection, and NDI sending all stay exactly as they are.
final class BackendProcess {
    let uiPort = 9333
    private var process: Process?

    /// `DISCORD_NDI_APP_DIR` overrides the app/ location for a packaged build; the
    /// default assumes a dev checkout, launched from the shell/discord-ndi-mac package
    /// directory (swift run's default cwd), where app/ is two levels up.
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

        let bun = ProcessInfo.processInfo.environment["BUN_PATH"] ?? "/usr/bin/env"
        let task = Process()
        // Not --headless: that flag skips the backend's whole HTTP server, API included.
        // This app only ignores ui.html and talks to the same /api/* JSON endpoints.
        if bun == "/usr/bin/env" {
            task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            task.arguments = ["bun", "run", appEntrypoint.path, "--ui", String(uiPort)]
        } else {
            task.executableURL = URL(fileURLWithPath: bun)
            task.arguments = ["run", appEntrypoint.path, "--ui", String(uiPort)]
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

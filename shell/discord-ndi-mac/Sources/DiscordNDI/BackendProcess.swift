import Foundation

/// Spawns and owns the existing Bun backend (app/index.ts) as a child process.
/// This is a native shell over that backend, not a reimplementation of it — the
/// CDP attach, renderer injection, and NDI sending all stay exactly as they are.
final class BackendProcess {
    let uiPort = BackendProcess.findPort(preferred: 9333)
    let backendPort = BackendProcess.findPort(preferred: 9191)

    private static func findPort(preferred: Int) -> Int {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = in_port_t(UInt16(preferred).bigEndian)
        
        var fd = socket(AF_INET, SOCK_STREAM, 0)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, len)
            }
        }
        
        if result != 0 {
            close(fd)
            fd = socket(AF_INET, SOCK_STREAM, 0)
            addr.sin_port = 0
            _ = withUnsafePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    bind(fd, sa, len)
                }
            }
        }
        
        _ = withUnsafeMutablePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                getsockname(fd, sa, &len)
            }
        }
        
        let port = Int(UInt16(bigEndian: addr.sin_port))
        close(fd)
        return port
    }

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
            task.arguments = ["run", indexJS.path, "--ui", String(uiPort), "--port", String(backendPort)]
            // Real on-disk index.js next to a real on-disk payload.ts/node_modules — the
            // same layout already proven to work for the standalone app and Electrobun
            // shell, so import.meta.url-relative resolution just works unmodified.
            task.currentDirectoryURL = indexJS.deletingLastPathComponent()
        } else {
            let bun = ProcessInfo.processInfo.environment["BUN_PATH"] ?? "/usr/bin/env"
            if bun == "/usr/bin/env" {
                task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                task.arguments = ["bun", "run", appEntrypoint.path, "--ui", String(uiPort), "--port", String(backendPort)]
            } else {
                task.executableURL = URL(fileURLWithPath: bun)
                task.arguments = ["run", appEntrypoint.path, "--ui", String(uiPort), "--port", String(backendPort)]
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

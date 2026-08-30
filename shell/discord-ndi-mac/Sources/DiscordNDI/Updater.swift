import Foundation
import AppKit
import Observation

/// Checks GitHub Releases for a newer tag than the running CFBundleShortVersionString
/// (kept in sync with the release tag by shell/discord-ndi-mac/package.sh), downloads
/// the DMG, and swaps it into place in the currently running app's own location.
///
/// No Sparkle/appcast: this app is ad-hoc signed (no paid Apple Developer account), so
/// there's no notarization pipeline for Sparkle to hook into anyway — a plain GitHub
/// Releases check + `xattr -cr` after the swap (the same workaround already documented
/// in the README for a fresh install) gets the same result with no new dependency.
@Observable
@MainActor
final class Updater {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case downloading(version: String)
        case readyToInstall(version: String)
        case installing
        case failed(String)
    }

    private(set) var state: State = .idle
    private var downloadedDmg: URL?
    private var pendingVersion: String?

    private static let repo = "aksisonline/Discord-NDI"
    private static let checkInterval: Duration = .seconds(6 * 60 * 60)

    func start() {
        Task { await check() }
        Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.checkInterval)
                await check()
            }
        }
    }

    func check() async {
        switch state {
        case .checking, .downloading, .installing: return
        default: break
        }
        state = .checking
        do {
            let url = URL(string: "https://api.github.com/repos/\(Self.repo)/releases/latest")!
            let (data, _) = try await URLSession.shared.data(from: url)
            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            let latest = release.tag_name.hasPrefix("v") ? String(release.tag_name.dropFirst()) : release.tag_name
            let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"

            guard Self.isNewer(latest, than: current) else {
                state = .upToDate
                return
            }
            guard let asset = release.assets.first(where: { $0.name.hasSuffix(".dmg") }) else {
                state = .failed("release \(release.tag_name) has no macOS build")
                return
            }
            await download(asset.browser_download_url, version: latest)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func download(_ urlString: String, version: String) async {
        guard let url = URL(string: urlString) else {
            state = .failed("bad asset URL")
            return
        }
        state = .downloading(version: version)
        do {
            let (tempFile, _) = try await URLSession.shared.download(from: url)
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent("Discord-NDI-\(version).dmg")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tempFile, to: dest)
            downloadedDmg = dest
            pendingVersion = version
            state = .readyToInstall(version: version)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Swaps the running app's own bundle for the downloaded one and relaunches.
    /// Deliberately not automatic: doing this mid-call would kill every NDI output and
    /// browser-view socket without warning, so it only runs on an explicit user click.
    func installAndRelaunch() {
        guard case .readyToInstall = state, let dmg = downloadedDmg else { return }
        state = .installing
        let appURL = Bundle.main.bundleURL
        Task.detached(priority: .userInitiated) {
            do {
                try await Self.performInstall(dmg: dmg, into: appURL)
                await MainActor.run {
                    let task = Process()
                    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                    task.arguments = ["-n", appURL.path]
                    try? task.run()
                    NSApp.terminate(nil)
                }
            } catch {
                await MainActor.run { self.state = .failed(error.localizedDescription) }
            }
        }
    }

    private static func performInstall(dmg: URL, into appURL: URL) async throws {
        let mountPoint = try attach(dmg: dmg)
        defer { try? detach(mountPoint: mountPoint) }

        let volumeContents = try FileManager.default.contentsOfDirectory(at: mountPoint, includingPropertiesForKeys: nil)
        guard let newApp = volumeContents.first(where: { $0.pathExtension == "app" }) else {
            throw UpdaterError.message("update image has no .app")
        }

        let fm = FileManager.default
        let backup = appURL.appendingPathExtension("previous")
        try? fm.removeItem(at: backup)
        // The running executable can be moved out from under itself on macOS — the
        // process keeps its open inode until it quits — so this is safe even though
        // this very code is executing from inside appURL right now.
        try fm.moveItem(at: appURL, to: backup)
        do {
            try fm.copyItem(at: newApp, to: appURL)
        } catch {
            try? fm.removeItem(at: appURL)
            try fm.moveItem(at: backup, to: appURL)
            throw error
        }
        try? fm.removeItem(at: backup)

        // Strips com.apple.quarantine (propagated from the quarantined DMG onto the
        // copied .app) so the relaunch doesn't hit the same Gatekeeper "damaged" error
        // a fresh manual download would — see the README's Troubleshooting section.
        let xattr = Process()
        xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        xattr.arguments = ["-cr", appURL.path]
        try xattr.run()
        xattr.waitUntilExit()
    }

    private static func attach(dmg: URL) throws -> URL {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        task.arguments = ["attach", "-nobrowse", "-noautoopen", "-plist", dmg.path]
        let pipe = Pipe()
        task.standardOutput = pipe
        try task.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else { throw UpdaterError.message("hdiutil attach failed") }

        guard let plist = try PropertyListSerialization.propertyList(from: output, format: nil) as? [String: Any],
              let entities = plist["system-entities"] as? [[String: Any]] else {
            throw UpdaterError.message("could not parse hdiutil output")
        }
        guard let mountPoint = entities.compactMap({ $0["mount-point"] as? String }).first else {
            throw UpdaterError.message("update image mounted with no volume")
        }
        return URL(fileURLWithPath: mountPoint)
    }

    private static func detach(mountPoint: URL) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        task.arguments = ["detach", mountPoint.path, "-quiet"]
        try task.run()
        task.waitUntilExit()
    }

    private static func isNewer(_ a: String, than b: String) -> Bool {
        let partsA = a.split(separator: ".").compactMap { Int($0) }
        let partsB = b.split(separator: ".").compactMap { Int($0) }
        for i in 0..<max(partsA.count, partsB.count) {
            let x = i < partsA.count ? partsA[i] : 0
            let y = i < partsB.count ? partsB[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}

enum UpdaterError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let m) = self { return m }
        return nil
    }
}

private struct GitHubRelease: Decodable {
    let tag_name: String
    let assets: [Asset]
    struct Asset: Decodable {
        let name: String
        let browser_download_url: String
    }
}

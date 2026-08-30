// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "DiscordNDI",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "DiscordNDI", path: "Sources/DiscordNDI")
    ]
)

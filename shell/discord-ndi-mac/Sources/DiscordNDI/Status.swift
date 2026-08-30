import Foundation

/// Mirrors Controller.status() + ndi.status() in app/index.ts / app/ndi.ts.
struct Status: Decodable {
    var running: Bool
    var port: Int
    var debugPort: Int
    /// Voice channel name, or nil when not currently in a call (or in one alone —
    /// see Controller.channelInfo's doc comment for that known ceiling).
    var name: String?
    var members: Int
    var ndi: Bool
    var error: String?
    var sources: [Source]

    var inCall: Bool { running && name != nil }

    struct Source: Decodable, Identifiable {
        var key: String
        var name: String
        var frames: Int
        var live: Bool
        var enabled: Bool
        var rotation: Int
        var url: String

        var id: String { key }
    }
}

import Foundation

/// Mirrors Controller.status() + ndi.status() in app/index.ts / app/ndi.ts.
struct Status: Decodable {
    var running: Bool
    var port: Int
    var debugPort: Int
    var ndi: Bool
    var error: String?
    var sources: [Source]

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

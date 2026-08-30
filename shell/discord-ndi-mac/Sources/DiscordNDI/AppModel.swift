import Foundation
import Observation

@Observable
@MainActor
final class AppModel {
    private let backend = BackendProcess()
    private let client: BackendClient
    private var pollTask: Task<Void, Never>?

    var status = Status(running: false, port: 0, debugPort: 0, ndi: true, error: nil, sources: [])
    let uiPort: Int

    init() {
        uiPort = backend.uiPort
        client = BackendClient(port: backend.uiPort)
    }

    func start() {
        backend.start()
        pollTask = Task {
            while !Task.isCancelled {
                if let latest = try? await client.status() {
                    status = latest
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        backend.stop()
    }

    func toggle(_ source: Status.Source) {
        Task { try? await client.setEnabled(source.key, !source.enabled) }
    }

    func rotate(_ source: Status.Source) {
        let next = [0: 90, 90: 180, 180: 270, 270: 0][source.rotation] ?? 0
        Task { try? await client.setRotation(source.key, next) }
    }
}

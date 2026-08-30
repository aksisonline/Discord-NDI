import Foundation

/// Thin client for the backend's existing /api/* routes (see app/index.ts `ui()`).
struct BackendClient {
    let port: Int
    private var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func status() async throws -> Status {
        let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("api/status"))
        return try JSONDecoder().decode(Status.self, from: data)
    }

    func setEnabled(_ key: String, _ enabled: Bool) async throws {
        try await post("api/source/\(key.urlEncoded)/enabled", jsonBody: #"{"enabled":\#(enabled)}"#)
    }

    func setRotation(_ key: String, _ rotation: Int) async throws {
        try await post("api/source/\(key.urlEncoded)/rotation", jsonBody: #"{"rotation":\#(rotation)}"#)
    }

    private func post(_ path: String, jsonBody: String) async throws {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = Data(jsonBody.utf8)
        _ = try await URLSession.shared.data(for: request)
    }
}

private extension String {
    var urlEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}

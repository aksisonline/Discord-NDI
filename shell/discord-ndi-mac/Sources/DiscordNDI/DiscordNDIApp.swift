import AppKit
import SwiftUI

@main
struct DiscordNDIApp: App {
    @State private var model = AppModel()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("Discord-NDI") {
            ContentView()
                .environment(model)
                .onAppear {
                    model.start()
                    appDelegate.model = model
                }
        }
        .windowResizability(.contentSize)
    }
}

/// SwiftUI's App protocol has no reliable termination hook; NSApplicationDelegate does.
/// Needed so the spawned Bun backend doesn't outlive the window when the app quits.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?

    func applicationWillTerminate(_ notification: Notification) {
        model?.stop()
    }
}

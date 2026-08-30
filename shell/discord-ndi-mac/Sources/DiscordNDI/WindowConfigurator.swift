import AppKit
import SwiftUI

/// SwiftUI has no direct modifier for the titlebar itself, only the content area
/// (containerBackground). Reaching the NSWindow is the only way to make the
/// titlebar/toolbar region blend into the same glass background instead of
/// showing as a flat gray bar above it — the Music.app/System Settings look.
private struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            // titlebarAppearsTransparent alone only makes the titlebar's own chrome
            // transparent — there is nothing behind it to show through until the
            // content view is told to extend up into that region too.
            window.styleMask.insert(.fullSizeContentView)
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.toolbarStyle = .unified
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) { }
}

extension View {
    func transparentTitlebar() -> some View {
        background(WindowConfigurator())
    }
}

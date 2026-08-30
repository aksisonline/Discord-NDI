import AppKit
import SwiftUI

/// SwiftUI's containerBackground(for: .window) only paints the content-layer area it
/// manages — it doesn't reach the titlebar region even after fullSizeContentView opens
/// that space up, so the titlebar kept rendering as a flat solid strip above it. Reaching
/// the NSWindow to install a real NSVisualEffectView behind *everything* is the actual
/// mechanism Music.app/System Settings use: one continuous material from the traffic
/// lights down, not two layers that only sometimes line up.
private struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window, let contentView = window.contentView else { return }

            window.styleMask.insert(.fullSizeContentView)
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.toolbarStyle = .unified
            window.isOpaque = false
            window.backgroundColor = .clear

            guard contentView.subviews.first(where: { $0 is NSVisualEffectView }) == nil else { return }
            let effect = NSVisualEffectView(frame: contentView.bounds)
            effect.autoresizingMask = [.width, .height]
            effect.material = .underWindowBackground
            effect.blendingMode = .behindWindow
            effect.state = .active
            contentView.addSubview(effect, positioned: .below, relativeTo: nil)
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

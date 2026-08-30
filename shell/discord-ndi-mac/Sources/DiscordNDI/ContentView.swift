import AppKit
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !model.status.ndi {
                Label("NDI unavailable: \(model.status.error ?? "grandiose failed to load")", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(.caption)
            }

            if model.status.inCall {
                channelBar
            }

            // Liquid Glass is reserved for the one functional/status element, which
            // lives in the toolbar below — content rows here stay plain; per-row
            // glass overuse dilutes emphasis.
            if !model.status.running {
                Spacer()
                emptyState(icon: "antenna.radiowaves.left.and.right", title: "Attaching…", subtitle: "Connecting to Discord.")
                Spacer()
            } else if !model.status.inCall {
                Spacer()
                emptyState(icon: "person.wave.2", title: "No active voice call", subtitle: "Join a voice channel in Discord to start capturing.")
                Spacer()
            } else if model.status.sources.isEmpty {
                Spacer()
                emptyState(icon: "video.slash", title: "Waiting for video", subtitle: "No one in the call has a camera or stream on yet.")
                Spacer()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(model.status.sources.enumerated()), id: \.element.id) { index, source in
                        if index > 0 { Divider() }
                        SourceRow(source: source, model: model)
                    }
                }
            }
        }
        .padding(20)
        .frame(minWidth: 420, minHeight: 340, alignment: .topLeading)
        // A window with a toolbar gets a translucent unified titlebar for free — no
        // manual NSVisualEffectView/titlebarAppearsTransparent surgery needed, and
        // fighting it with custom backgrounds there only clashes with the material.
        // containerBackground now unifies with that same toolbar material instead of
        // stopping short of it, which is what broke without a real toolbar present.
        .containerBackground(.thickMaterial, for: .window)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.status.running ? .green : .secondary)
                .frame(width: 8, height: 8)
            Text(model.status.running ? "Capturing" : "Attaching…")
                .font(.headline)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .glassEffect(.regular.tint(model.status.running ? .green : .clear), in: .capsule)
    }

    private var channelBar: some View {
        HStack(spacing: 6) {
            Text(model.status.name ?? "").fontWeight(.semibold)
            Text("·").foregroundStyle(.tertiary)
            Text("\(model.status.members) member\(model.status.members == 1 ? "" : "s")")
            Text("·").foregroundStyle(.tertiary)
            Text("\(model.status.sources.count) stream\(model.status.sources.count == 1 ? "" : "s")")
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private func emptyState(icon: String, title: String, subtitle: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
                .padding(.bottom, 4)
            Text(title).font(.headline)
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
}

private struct SourceRow: View {
    let source: Status.Source
    let model: AppModel
    @State private var copied = false

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(source.name)
                    .fontWeight(.medium)
                if source.enabled {
                    Text("\(source.url) · \(source.rotation)°")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    Text("off — source paused")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            HStack(spacing: 10) {
                Button {
                    copyURL()
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy source URL")
                .disabled(!source.enabled)

                Button {
                    model.rotate(source)
                } label: {
                    Image(systemName: "rotate.right")
                }
                .buttonStyle(.borderless)
                .help("Rotate 90°")

                Toggle("", isOn: Binding(get: { source.enabled }, set: { _ in model.toggle(source) }))
                    .labelsHidden()
                    .toggleStyle(.switch)
            }
        }
        .padding(.vertical, 10)
        .opacity(source.enabled ? 1 : 0.6)
    }

    private func copyURL() {
        let full = "http://127.0.0.1:\(model.uiPort)\(source.url)"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(full, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }
}

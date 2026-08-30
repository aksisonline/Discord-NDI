import AppKit
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            if !model.status.ndi {
                Label("NDI unavailable: \(model.status.error ?? "grandiose failed to load")", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .font(.caption)
            }

            // Liquid Glass is reserved for the one functional/status element above;
            // content rows below are plain, per-row glass overuse dilutes emphasis.
            if model.status.sources.isEmpty {
                Text(model.status.running ? "Attached. Waiting for someone to turn a camera on." : "Not capturing.")
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(model.status.sources.enumerated()), id: \.element.id) { index, source in
                        if index > 0 { Divider() }
                        SourceRow(source: source, model: model)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        // fullSizeContentView (in transparentTitlebar()) extends content up under the
        // traffic lights; clear them explicitly instead of guessing a fixed inset.
        .padding(.top, 28)
        .frame(minWidth: 420, minHeight: 340, alignment: .topLeading)
        .containerBackground(.thickMaterial, for: .window)
        .transparentTitlebar()
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
        .padding(.vertical, 10)
        .glassEffect(.regular.tint(model.status.running ? .green : .clear), in: .capsule)
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

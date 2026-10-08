# Porting Compositor to other platforms

Compositor is macOS-only today: the UI is SwiftUI and AppKit, the renderer is Metal, and it requires macOS 26 on Apple silicon. This document maps where the platform dependencies live, what can already move to Windows and Linux, and the roadmap for getting there.

The scaffolding lives on the `multi-platform` branch:

- `ports/tauri/` — a Tauri 2 app (web frontend, Rust backend) that reads, renders, lightly edits and exports `.comp` projects on Windows, Linux and macOS. The Rust backend validates manifests and assets against the limits in [project-format.md](project-format.md).
- `Compositor/Platform/Platform.swift` — Foundation-only platform and capability detection for the Swift core
- `.github/workflows/build.yml` — builds an unsigned macOS app, and typechecks the platform layer with swiftc on Linux and Windows on every push
- `.github/workflows/tauri-build.yml` — builds the Tauri port into NSIS (Windows) and deb/AppImage (Linux) bundles on every push

### The Tauri port

`ports/tauri` is the Windows and Linux application shell. It is a real Tauri 2 app:

- **Frontend** (`ports/tauri/src`, plain HTML/JS, no build step): project browser, canvas compositing (blend modes, transforms, raster masks, group opacity), a layers panel with visibility/opacity/blend/reorder editing, and flattened PNG export.
- **Backend** (`ports/tauri/src-tauri`, Rust): `.comp` package loading with format validation (version 1-11, size and layer limits, safe asset paths), atomic manifest saves, PNG export through the native save dialog.
- **Limits honored from the format spec**: 4 MiB manifests, 512 MiB assets, 10,000 layers, 30,000-pixel canvas sides.

Not yet in the port: adjustment layers and layer effects do not render (their metadata round-trips untouched), live clipping masks (`maskSourceID`) are not applied, and text renders from its saved PNG.

## Dependency map

| Layer | Frameworks | Portability |
|---|---|---|
| `Document/` (model, tools, adjustments) | Foundation, CoreGraphics, simd | High. AppKit appears in ~19 places: `NSPasteboard` in `SelectionClipboard.swift` and `ProjectWorkspace.swift`, `NSFont`/`NSColor` in `TypeTool.swift`, `Dither.swift` and `ColorPalette.swift`, `NSImage` in `SelectionClipboard.swift` |
| `IO/PSD/` (PSD/PSB read and write) | Foundation, CoreGraphics | High. Pure data plumbing around CoreGraphics types |
| `IO/` (import/export, project store) | ImageIO, CoreImage, AppKit, UniformTypeIdentifiers, CryptoKit | Medium. Needs codec replacements (PNG/JPEG/HEIC/TIFF) and a CoreImage-free RAW path; CryptoKit maps to swift-crypto |
| `Rendering/` (compositing, brush, effects) | Metal, CoreImage, AppKit, QuartzCore, Accelerate | Low. Metal is the engine; a Vulkan or Direct3D backend is a rewrite of this layer |
| `UI/` (panels, sheets, canvas chrome) | SwiftUI, AppKit | None. Rebuilt per toolkit |
| Auto-update | Sparkle | macOS-only by design; each platform needs its own updater |

## What already works cross-platform

- The `.comp` project format (see [project-format.md](project-format.md)): a folder of PNG layers plus a JSON manifest. Any platform can read and write projects without this codebase.
- The PSD reader/writer and most of the `Document/` algorithms, once the ~19 AppKit touch points are moved behind abstractions (a clipboard protocol, font metrics, color conversion).

## Strategy

1. **Keep Swift as the core on macOS; drive the port from the file format.** The document model, adjustments, blend math and file formats stay in one Swift codebase for the Mac app. The cross-platform shell is a **Tauri 2** app (chosen over Qt/GTK for its small bundles, Rust backend and webview frontend): it speaks the `.comp` format directly, so both apps read and write the same projects.
2. **Abstract the platform edges, not the middle.** Introduce small protocols for clipboard, fonts, image codecs and the GPU surface; macOS keeps its existing implementations, and each port supplies its own.
3. **Grow the Tauri frontend toward the real app.** The port renders composites with canvas 2D today; compositing moves into a Rust/WGPU pipeline as effects and adjustments arrive, and the UI grows panels piece by piece.
4. **Replace Metal last.** A CPU raster path (Accelerate maps to its own SIMD on other platforms) can unblock a usable port; GPU acceleration via Vulkan/Direct3D comes after the app is functional.

## Roadmap

- **Phase 0 — scaffolding (done).** Platform module in place; CI typechecks it on Linux and Windows; macOS builds produce unsigned app artifacts.
- **Phase 1 — Tauri shell (done).** `ports/tauri` loads and validates `.comp` projects, renders layers with blend modes, transforms, masks and group opacity, edits visibility/opacity/blend/order, saves manifests atomically and exports PNG. CI produces Windows NSIS and Linux deb/AppImage bundles.
- **Phase 2 — de-AppKit the Swift core.** Move `Document/`'s clipboard, font-metric and color dependencies behind protocols with macOS implementations, so the model can compile outside Apple platforms for a future shared engine.
- **Phase 3 — platform I/O.** Codec layer for PNG/JPEG (and HEIC/TIFF where available), a CoreImage-free RAW path, swift-crypto for digests, then a headless CLI that renders `.comp` projects on every platform.
- **Phase 4 — feature parity.** Adjustment layers and effects in the Tauri renderer (Rust/WGPU), live clipping masks, text rendering, and per-platform updaters to replace Sparkle.

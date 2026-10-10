# Porting Compositor to other platforms

Compositor is macOS-only today: the UI is SwiftUI and AppKit, the renderer is Metal, and it requires macOS 26 on Apple silicon. This document maps where the platform dependencies live, what can already move to Windows and Linux, and the roadmap for getting there.

The scaffolding lives on the `multi-platform` branch:

- `ports/tauri/` — a Tauri 2 app (web frontend, Rust backend) that reads, renders, lightly edits and exports `.comp` projects on Windows, Linux and macOS. The Rust backend validates manifests and assets against the limits in [project-format.md](project-format.md).
- `ports/electron/` — the same JS frontend under an Electron shell (Node backend, no Rust toolchain needed). See below.
- `Compositor/Platform/Platform.swift` — Foundation-only platform and capability detection for the Swift core
- `.github/workflows/build.yml` — builds an unsigned macOS app, and typechecks the platform layer with swiftc on Linux and Windows on every push
- `.github/workflows/tauri-build.yml` — builds the Tauri port into NSIS (Windows) and deb/AppImage (Linux) bundles on every push
- `.github/workflows/electron-build.yml` — builds the Electron port into NSIS+zip (Windows), dmg+zip (macOS) and AppImage+deb (Linux) installers on every push; a `v*` tag publishes them all to one GitHub release

### The Tauri port

`ports/tauri` is the Windows and Linux application shell. It is a real Tauri 2 app:

- **Frontend** (`ports/tauri/src`, plain HTML/JS, no build step): project browser, canvas compositing (blend modes, transforms, raster masks, group opacity), adjustment layers and layer effects, text rendering from its metadata, a layers panel with visibility/opacity/blend/reorder editing, selections (marquee/lasso/wand/color range/subject), tools (brush, clone stamp, spot healing, liquify, gradient, shape, type, crop), and flattened PNG/JPEG export with a menu bar mirroring the macOS command structure.
- **Backend** (`ports/tauri/src-tauri`, Rust): `.comp` package loading with format validation (version 1-11, size and layer limits, safe asset paths), atomic manifest saves, save-as destination picking, and PNG/JPEG export through the native save dialog.
- **Limits honored from the format spec**: 4 MiB manifests, 512 MiB assets, 10,000 layers, 30,000-pixel canvas sides.

Still missing versus the macOS app: ML subject separation (Select › Subject uses a border flood-fill approximation instead of Vision), the Keyboard Shortcuts settings window, canvas rulers, and per-platform updaters.

### The Electron port

`ports/electron` runs the identical editor frontend as the Tauri port (plain HTML/JS, no build step) with two single-line differences: `app.js` and `io.js` read the IPC surface from `window.__COMPOSITOR__.core` instead of `window.__TAURI__.core`. Keep the two ports' `src/` trees in sync when fixing frontend behavior.

- **Shell** (`main.cjs`): a BrowserWindow (1360×860, min 940×600, matching the Tauri window config) loading the frontend over a privileged `app://bundle/` protocol, so ES module imports work where plain `file://` URLs would be CORS-blocked. The renderer runs sandboxed with a CommonJS context-bridge preload (`preload.cjs`) exposing the invoke surface. The main process and backend are CommonJS (`.cjs`): this Electron build mis-loads ESM main processes, and `.cjs` keeps them safe regardless of a `type` field.
- **Backend** (`backend.cjs`): the Node port of `src-tauri/src/comp.rs`. Same seven commands (`pick_folder`, `pick_save_path`, `list_projects`, `load_project`, `save_project`, `export_file`, `import_images`), same format validation (version 1–11, size and layer limits, safe asset paths), same atomic temp-then-rename saves, and the same PNG pHYs / JPEG JFIF density stamping, with identical error strings. It is Electron-free by design so `node --test` can exercise it directly; native dialogs are injected by `main.cjs`.
- **Tests** (`e2e/unit/`): the frontend unit tests shared with the Tauri port (adjustments, dither, heal, psd) plus `backend.test.mjs`, mirroring the Rust backend's `#[cfg(test)]` coverage. `smoke.mjs` launches the app and asserts the window process survives 12 seconds.
- **Run**: `npm install && npm start`; test with `npm test`, smoke with `node smoke.mjs`. Note for embedders: `ELECTRON_RUN_AS_NODE` in the environment turns the binary into plain Node — unset it when launching the GUI from an Electron-based host.
- **Packaging**: `npm run dist` (electron-builder) produces installers for the host platform — NSIS+zip on Windows, dmg+zip on macOS (unsigned; CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`), AppImage+deb on Linux. CI runs this on all three OSes on every push (`.github/workflows/electron-build.yml`), uploads per-OS artifacts, and attaches them to the GitHub release on `v*` tags alongside the Tauri bundles.

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

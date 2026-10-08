import Foundation

/// Compile-time platform identification for the cross-platform effort
/// described in docs/PORTING.md. Foundation-only, so this file builds
/// unchanged with swiftc on macOS, Linux and Windows.
enum CompositorPlatform: String {
    case macOS
    case linux
    case windows
    case unknown

    /// The platform this build was compiled for.
    static let current: CompositorPlatform = {
        #if os(macOS)
        return .macOS
        #elseif os(Linux)
        return .linux
        #elseif os(Windows)
        return .windows
        #else
        return .unknown
        #endif
    }()
}

/// Capability flags checked before touching platform-specific frameworks.
/// Each flag mirrors a dependency from docs/PORTING.md, so a port can compile
/// the core with every unsupported path turned off.
enum PlatformCapabilities {
    /// Metal renderer (Rendering/). Apple platforms only; a Vulkan or
    /// Direct3D backend is future work.
    static let hasMetal: Bool = {
        #if canImport(Metal)
        return true
        #else
        return false
        #endif
    }()

    /// CoreGraphics raster pipeline used across Document/ and IO/.
    static let hasCoreGraphics: Bool = {
        #if canImport(CoreGraphics)
        return true
        #else
        return false
        #endif
    }()

    /// AppKit services (clipboard, fonts, colors) still referenced by Document/.
    static let hasAppKit: Bool = {
        #if canImport(AppKit)
        return true
        #else
        return false
        #endif
    }()

    /// The .comp format (docs/project-format.md) is a folder of PNG layers
    /// plus a JSON manifest, so projects round-trip on every platform.
    static let hasCompProjects = true
}

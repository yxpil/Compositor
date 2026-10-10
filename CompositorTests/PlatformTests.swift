import XCTest
@testable import Compositor

final class PlatformTests: XCTestCase {
    func testCurrentPlatformMatchesCompilationTarget() {
        #if os(macOS)
        XCTAssertEqual(CompositorPlatform.current, .macOS)
        #elseif os(Linux)
        XCTAssertEqual(CompositorPlatform.current, .linux)
        #elseif os(Windows)
        XCTAssertEqual(CompositorPlatform.current, .windows)
        #else
        XCTAssertEqual(CompositorPlatform.current, .unknown)
        #endif
    }

    func testMacBuildReportsFullCapabilities() {
        #if os(macOS)
        XCTAssertTrue(PlatformCapabilities.hasMetal)
        XCTAssertTrue(PlatformCapabilities.hasCoreGraphics)
        XCTAssertTrue(PlatformCapabilities.hasAppKit)
        #else
        XCTAssertFalse(PlatformCapabilities.hasMetal)
        XCTAssertFalse(PlatformCapabilities.hasAppKit)
        #endif
        XCTAssertTrue(PlatformCapabilities.hasCoreGraphics == PlatformCapabilities.hasMetal)
        XCTAssertTrue(PlatformCapabilities.hasCompProjects)
    }
}

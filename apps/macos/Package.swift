// swift-tools-version: 6.2
// Package manifest for the FRIDAY macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "FRIDAY",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "FRIDAYIPC", targets: ["FRIDAYIPC"]),
        .library(name: "FRIDAYDiscovery", targets: ["FRIDAYDiscovery"]),
        .executable(name: "FRIDAY", targets: ["FRIDAY"]),
        .executable(name: "friday-mac", targets: ["FRIDAYMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/FRIDAYKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "FRIDAYIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FRIDAYDiscovery",
            dependencies: [
                .product(name: "FRIDAYKit", package: "FRIDAYKit"),
            ],
            path: "Sources/FRIDAYDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "FRIDAY",
            dependencies: [
                "FRIDAYIPC",
                "FRIDAYDiscovery",
                .product(name: "FRIDAYKit", package: "FRIDAYKit"),
                .product(name: "FRIDAYChatUI", package: "FRIDAYKit"),
                .product(name: "FRIDAYProtocol", package: "FRIDAYKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/FRIDAY.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "FRIDAYMacCLI",
            dependencies: [
                "FRIDAYDiscovery",
                .product(name: "FRIDAYKit", package: "FRIDAYKit"),
                .product(name: "FRIDAYProtocol", package: "FRIDAYKit"),
            ],
            path: "Sources/FRIDAYMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "FRIDAYIPCTests",
            dependencies: [
                "FRIDAYIPC",
                "FRIDAY",
                "FRIDAYDiscovery",
                .product(name: "FRIDAYProtocol", package: "FRIDAYKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])

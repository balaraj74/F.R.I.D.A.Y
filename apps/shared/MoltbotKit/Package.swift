// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "FRIDAYKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "FRIDAYProtocol", targets: ["FRIDAYProtocol"]),
        .library(name: "FRIDAYKit", targets: ["FRIDAYKit"]),
        .library(name: "FRIDAYChatUI", targets: ["FRIDAYChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "FRIDAYProtocol",
            path: "Sources/FRIDAYProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FRIDAYKit",
            dependencies: [
                "FRIDAYProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/FRIDAYKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FRIDAYChatUI",
            dependencies: [
                "FRIDAYKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/FRIDAYChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "FRIDAYKitTests",
            dependencies: ["FRIDAYKit", "FRIDAYChatUI"],
            path: "Tests/FRIDAYKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])

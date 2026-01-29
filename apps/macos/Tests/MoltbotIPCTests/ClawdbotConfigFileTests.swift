import Foundation
import Testing
@testable import FRIDAY

@Suite(.serialized)
struct FRIDAYConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("friday-config-\(UUID().uuidString)")
            .appendingPathComponent("friday.json")
            .path

        await TestIsolation.withEnvValues(["FRIDAY_CONFIG_PATH": override]) {
            #expect(FRIDAYConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("friday-config-\(UUID().uuidString)")
            .appendingPathComponent("friday.json")
            .path

        await TestIsolation.withEnvValues(["FRIDAY_CONFIG_PATH": override]) {
            FRIDAYConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(FRIDAYConfigFile.remoteGatewayPort() == 19999)
            #expect(FRIDAYConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(FRIDAYConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(FRIDAYConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("friday-config-\(UUID().uuidString)")
            .appendingPathComponent("friday.json")
            .path

        await TestIsolation.withEnvValues(["FRIDAY_CONFIG_PATH": override]) {
            FRIDAYConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            FRIDAYConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = FRIDAYConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("friday-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "FRIDAY_CONFIG_PATH": nil,
            "FRIDAY_STATE_DIR": dir,
        ]) {
            #expect(FRIDAYConfigFile.stateDirURL().path == dir)
            #expect(FRIDAYConfigFile.url().path == "\(dir)/friday.json")
        }
    }
}

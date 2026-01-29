import Foundation

public enum FRIDAYCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum FRIDAYCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum FRIDAYCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum FRIDAYCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct FRIDAYCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: FRIDAYCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: FRIDAYCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: FRIDAYCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: FRIDAYCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct FRIDAYCameraClipParams: Codable, Sendable, Equatable {
    public var facing: FRIDAYCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: FRIDAYCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: FRIDAYCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: FRIDAYCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}

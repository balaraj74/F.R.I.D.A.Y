import Foundation

public enum FRIDAYChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(FRIDAYChatEventPayload)
    case agent(FRIDAYAgentEventPayload)
    case seqGap
}

public protocol FRIDAYChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> FRIDAYChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [FRIDAYChatAttachmentPayload]) async throws -> FRIDAYChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> FRIDAYChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<FRIDAYChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension FRIDAYChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "FRIDAYChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> FRIDAYChatSessionsListResponse {
        throw NSError(
            domain: "FRIDAYChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}

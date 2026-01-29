import Testing
@testable import FRIDAY

@Suite(.serialized)
@MainActor
struct NodePairingApprovalPrompterTests {
    @Test func nodePairingApprovalPrompterExercises() async {
        await NodePairingApprovalPrompter.exerciseForTesting()
    }
}

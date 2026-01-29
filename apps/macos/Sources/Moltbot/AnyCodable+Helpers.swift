import FRIDAYKit
import FRIDAYProtocol
import Foundation

// Prefer the FRIDAYKit wrapper to keep gateway request payloads consistent.
typealias AnyCodable = FRIDAYKit.AnyCodable
typealias InstanceIdentity = FRIDAYKit.InstanceIdentity

extension AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: AnyCodable]? { self.value as? [String: AnyCodable] }
    var arrayValue: [AnyCodable]? { self.value as? [AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}

extension FRIDAYProtocol.AnyCodable {
    var stringValue: String? { self.value as? String }
    var boolValue: Bool? { self.value as? Bool }
    var intValue: Int? { self.value as? Int }
    var doubleValue: Double? { self.value as? Double }
    var dictionaryValue: [String: FRIDAYProtocol.AnyCodable]? { self.value as? [String: FRIDAYProtocol.AnyCodable] }
    var arrayValue: [FRIDAYProtocol.AnyCodable]? { self.value as? [FRIDAYProtocol.AnyCodable] }

    var foundationValue: Any {
        switch self.value {
        case let dict as [String: FRIDAYProtocol.AnyCodable]:
            dict.mapValues { $0.foundationValue }
        case let array as [FRIDAYProtocol.AnyCodable]:
            array.map(\.foundationValue)
        default:
            self.value
        }
    }
}

import Foundation

private struct RootCommand {
    var name: String
    var args: [String]
}

@main
struct FRIDAYMacCLI {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        let command = parseRootCommand(args)
        switch command?.name {
        case nil:
            printUsage()
        case "-h", "--help", "help":
            printUsage()
        case "connect":
            await runConnect(command?.args ?? [])
        case "discover":
            await runDiscover(command?.args ?? [])
        case "wizard":
            await runWizardCommand(command?.args ?? [])
        default:
            fputs("friday-mac: unknown command\n", stderr)
            printUsage()
            exit(1)
        }
    }
}

private func parseRootCommand(_ args: [String]) -> RootCommand? {
    guard let first = args.first else { return nil }
    return RootCommand(name: first, args: Array(args.dropFirst()))
}

private func printUsage() {
    print("""
    friday-mac

    Usage:
      friday-mac connect [--url <ws://host:port>] [--token <token>] [--password <password>]
                           [--mode <local|remote>] [--timeout <ms>] [--probe] [--json]
                           [--client-id <id>] [--client-mode <mode>] [--display-name <name>]
                           [--role <role>] [--scopes <a,b,c>]
      friday-mac discover [--timeout <ms>] [--json] [--include-local]
      friday-mac wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
                          [--mode <local|remote>] [--workspace <path>] [--json]

    Examples:
      friday-mac connect
      friday-mac connect --url ws://127.0.0.1:18789 --json
      friday-mac discover --timeout 3000 --json
      friday-mac wizard --mode local
    """)
}

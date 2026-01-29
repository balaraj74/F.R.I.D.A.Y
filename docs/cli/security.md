---
summary: "CLI reference for `friday security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe “fix” suggestions (chmod, tighten defaults)
---

# `friday security`

Security tools (audit + optional fixes).

Related:
- Security guide: [Security](/gateway/security)

## Audit

```bash
friday security audit
friday security audit --deep
friday security audit --fix
```

The audit warns when multiple DM senders share the main session and recommends `session.dmScope="per-channel-peer"` (or `per-account-channel-peer` for multi-account channels) for shared inboxes.
It also warns when small models (`<=300B`) are used without sandboxing and with web/browser tools enabled.

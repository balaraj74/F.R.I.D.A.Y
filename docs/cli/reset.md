---
summary: "CLI reference for `friday reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
---

# `friday reset`

Reset local config/state (keeps the CLI installed).

```bash
friday reset
friday reset --dry-run
friday reset --scope config+creds+sessions --yes --non-interactive
```


---
summary: "CLI reference for `friday plugins` (list, install, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
---

# `friday plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:
- Plugin system: [Plugins](/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
friday plugins list
friday plugins info <id>
friday plugins enable <id>
friday plugins disable <id>
friday plugins doctor
friday plugins update <id>
friday plugins update --all
```

Bundled plugins ship with FRIDAY but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `friday.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
friday plugins install <path-or-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
friday plugins install -l ./my-plugin
```

### Update

```bash
friday plugins update <id>
friday plugins update --all
friday plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).

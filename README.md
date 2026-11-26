# 🤖 F.R.I.D.A.Y — Your Personal AI Assistant

<p align="center">
  <img src="assets/friday-logo.jpg" alt="F.R.I.D.A.Y" width="400">
</p>

<p align="center">
  <strong>Female Replacement Intelligent Digital Assistant Youth</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Platform-Any%20OS-green.svg?style=for-the-badge" alt="Platform">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-brightgreen.svg?style=for-the-badge" alt="Node Version">
</p>

---

## 🌟 Overview

**F.R.I.D.A.Y** is a powerful, personal AI assistant that you run on your own devices. Inspired by Tony Stark's AI companion, F.R.I.D.A.Y provides intelligent assistance across multiple platforms and communication channels.

### Key Features

- 🚀 **Multi-Channel Support** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, and more
- 🎙️ **Voice Interaction** — Voice Wake + Talk Mode for hands-free operation
- 🖥️ **Cross-Platform** — Works on macOS, Linux, and Windows (via WSL2)
- 🔒 **Privacy-First** — Runs locally on your devices, your data stays yours
- 🛠️ **Extensible** — Plugin architecture for custom skills and integrations
- 🌐 **Gateway Architecture** — Single control plane for all your AI interactions

---

## 🚀 Quick Start

### Prerequisites

- **Node.js ≥22** (required)
- **pnpm** (recommended) or npm/bun

### Installation

```bash
# Install globally
npm install -g friday@latest
# or: pnpm add -g friday@latest

# Run the onboarding wizard
friday onboard --install-daemon
```

## ⚡ 1-Command Setup & Launch (For Any Laptop / Friend's Machine)

Everything—the **Antigravity Claude Proxy**, the **F.R.I.D.A.Y. Gateway**, and the **Sci-Fi Holographic Desktop HUD**—is consolidated in this single repository:

```bash
# 1. Clone repository
git clone https://github.com/balaraj74/F.R.I.D.A.Y.git
cd F.R.I.D.A.Y

# 2. One-command automated installation & build
./setup.sh

# 3. One-command boot (launches Proxy + Gateway + HUD)
./start.sh
```

To stop all services anytime:
```bash
./stop.sh
```

---

## 🚀 Manual Running from Source

```bash
# Clone the repository
git clone https://github.com/balaraj74/F.R.I.D.A.Y.git
cd F.R.I.D.A.Y

# Install dependencies
pnpm install
pnpm ui:build
pnpm build

# Run onboarding
pnpm friday onboard --install-daemon

# Start the gateway (dev mode with auto-reload)
pnpm gateway:watch
```

---

## 🏗️ Architecture

```
WhatsApp / Telegram / Slack / Discord / Signal / iMessage / Teams
                │
                ▼
┌───────────────────────────────┐
│            Gateway            │
│       (control plane)         │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ AI Agent (RPC)
               ├─ CLI (friday …)
               ├─ WebChat UI
               ├─ macOS app
               └─ iOS / Android nodes
```

---

## 📱 Supported Channels

| Channel | Status | Notes |
|---------|--------|-------|
| WhatsApp | ✅ | Via Baileys |
| Telegram | ✅ | Via grammY |
| Slack | ✅ | Via Bolt |
| Discord | ✅ | Via discord.js |
| Signal | ✅ | Via signal-cli |
| iMessage | ✅ | macOS only |
| Microsoft Teams | ✅ | Via extension |
| Google Chat | ✅ | Via Chat API |
| WebChat | ✅ | Built-in |

---

## ⚙️ Configuration

Minimal configuration (`~/.friday/friday.json`):

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5"
  }
}
```

### Supported Models

- **Anthropic** — Claude Pro/Max (recommended for best performance)
- **OpenAI** — GPT-4, ChatGPT
- Any other compatible LLM provider

---

## 🔧 Chat Commands

Use these commands in any connected channel:

| Command | Description |
|---------|-------------|
| `/status` | Show session status (model + tokens) |
| `/new` or `/reset` | Reset the session |
| `/compact` | Compact session context |
| `/think <level>` | Set thinking level (off/minimal/low/medium/high) |
| `/verbose on/off` | Toggle verbose mode |
| `/usage off/tokens/full` | Per-response usage footer |

---

## 🔒 Security

F.R.I.D.A.Y is designed with security in mind:

- **DM Pairing** — Unknown senders receive a pairing code before access
- **Allowlists** — Configure who can interact with your assistant
- **Sandbox Mode** — Run non-main sessions in Docker sandboxes
- **Local-First** — Your data stays on your devices

---

## 📖 Documentation

- [Getting Started Guide](#quick-start)
- [Configuration Reference](#configuration)
- [Channel Setup](#supported-channels)
- [Security Guide](#security)

---

## 👨‍💻 Developer

<p align="center">
  <img src="https://img.shields.io/badge/Developer-Balaraj%20R-blue?style=for-the-badge" alt="Developer">
</p>

**Created and maintained by:**

| | |
|---|---|
| 👤 **Name** | Balaraj R |
| 📧 **Email** | [balarajr483@gmail.com](mailto:balarajr483@gmail.com) |
| 🐙 **GitHub** | [@balaraj74](https://github.com/balaraj74) |

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Inspired by F.R.I.D.A.Y from the Marvel Cinematic Universe
- Built with modern AI technologies
- Powered by open-source community contributions

---

<p align="center">
  <strong>🤖 "Hello! I'm F.R.I.D.A.Y. How can I assist you today?" 🤖</strong>
</p>

<p align="center">
  Made with ❤️ by Balaraj R
</p>

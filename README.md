# KODA — AI Code Editor

> Cursor-style AI coding inside VS Code. A HYNAWEB product.

Copyright (c) 2026 HYNAWEB. All rights reserved.

---

## About

KODA is a proprietary VS Code extension that brings AI-assisted coding directly
into the editor. Chat in the sidebar, explain any selection, or press `Ctrl+Alt+I`
to rewrite code in place. Replies include Markdown, syntax-highlighted code
blocks, and optional live web search with cited sources.

## Features

- **Sidebar chat** — persistent conversation, right inside VS Code
- **Inline edit** (`Ctrl+Alt+I`) — select code, describe the change, get a diff
- **Explain selection** (`Ctrl+Alt+K`) — 4-step explanation of any code
- **`@` file mentions** — attach any workspace file to your prompt
- **`#` selection attach** — pull the current editor selection into chat
- **Apply / View diff** — accept KODA's edits with one click or preview first
- **Live web search** — toggle the Web button for up-to-date answers with sources
- **Multi-file edits** — apply all proposed changes at once

## Quick start

1. Install the extension.
2. Click the **KODA** icon in the left activity bar.
3. Ask anything.

## Commands

| Command | Shortcut | What it does |
|---|---|---|
| KODA: Open Chat | `Ctrl+Alt+L` | Focus the chat panel |
| KODA: Inline Edit | `Ctrl+Alt+I` | Edit selection or file with a prompt |
| KODA: Explain Selection | `Ctrl+Alt+K` | Explain selected code |
| KODA: Clear Chat | — | Reset the conversation |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `koda.workerUrl` | `https://koda-api-proxy.harun9842245.workers.dev` | Backend Worker URL |
| `koda.autoApply` | `false` | Auto-apply edits from chat |
| `koda.maxContextFiles` | `6` | How many open files to attach as context |
| `koda.webSearchByDefault` | `false` | Enable web search on every message |

## License

This is proprietary software owned by HYNAWEB. No part of this project may be
copied, modified, redistributed, or reused without written permission from the
author. See [LICENSE](./LICENSE) for full terms.

## Author

Harun · HYNAWEB · built on a POCO C55

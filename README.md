# dorimaki

**Fan-made Discord bot for [OmO](https://omo.dev)** — not affiliated with Sisyphus Labs.

dorimaki = **dori** (the OmO ecosystem bot concept) × **[kimaki](https://github.com/remorses/kimaki)** (the Discord bot shell).

kimaki is a Discord bot that drives [OpenCode](https://opencode.ai) sessions. dorimaki keeps kimaki's entire Discord layer — channel creation, thread sessions, action buttons, question prompts, file uploads, streaming message rendering — and swaps the engine underneath: instead of `opencode serve`, it drives **omo's app-server** (`omo app-server`, Codex app-server JSON-RPC protocol).

```
Discord  ←→  dorimaki bot (channels · buttons · markdown rendering)
                  ↕
          engine adapter (src/omo/)
                  ↕
     omo app-server (ws JSON-RPC)  ← your models, your keys
```

## Why

- You like omo (model mixing, favorites, skills) but want to talk to it from Discord like kimaki users do.
- Everything runs **on your machine**: your code, your API keys, your sessions. The default mode is self-hosted — your Discord bot token never leaves your box.

## Install

```bash
# prerequisites: Node.js 22+, omo installed and authenticated
curl -fsSL https://get.omo.dev/install.sh | bash
omo auth check --provider <your-provider>   # make sure at least one model works

npx dorimaki
```

First run walks you through creating a self-hosted Discord bot:

1. Create an app at https://discord.com/developers/applications → **New Application**
2. Bot tab → enable **Message Content Intent** and **Server Members Intent**
3. Copy the bot token into the dorimaki setup wizard
4. Open the printed install URL to invite the bot to your server

## How it works

- Every project directory maps to a Discord **channel**; every agent session is a **thread**.
- Messages you post in a thread are sent to omo (`turn/start`); omo's streaming events are rendered live into Discord messages.
- Interactive tools — action buttons, questions, file uploads, session sleep — are surfaced as native Discord UI.
- Models are omo's: `omo models discover`, your `models.json` favorites, and per-thread `/model` selection all work the omo way.

### Engine mapping

| kimaki (opencode) | dorimaki (omo) |
| --- | --- |
| `opencode serve` HTTP+SSE | `omo app-server --listen ws://` |
| `session.create` | `thread/start` (cwd + model) |
| `session.promptAsync` | `turn/start` |
| `session.abort` | `turn/interrupt` |
| SSE `global.event` | ws notifications (`item/*`, `thread/*`, `turn/*`) |
| permission/question prompts | JSON-RPC server requests → Discord buttons |

## Status

Early development. Works: sessions, streaming, model selection at thread start, history. Stubs: session compaction (`summarize`), undo (`revert`/`unrevert`). See commit history for progress.

## License

MIT. Based on [kimaki](https://github.com/remorses/kimaki) (MIT) by remorses.

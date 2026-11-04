# dorimaki

**Fan-made Discord bot for [OmO](https://omo.dev)** — not affiliated with Sisyphus Labs.

dorimaki = **dori** (the OmO ecosystem bot concept) × **[kimaki](https://github.com/remorses/kimaki)** (the Discord bot shell).

kimaki is a Discord bot that drives [OpenCode](https://opencode.ai) sessions. dorimaki keeps kimaki's entire Discord layer — channel creation, thread sessions, action buttons, question prompts, file uploads, streaming message rendering — and swaps the engine underneath: instead of `opencode serve`, it drives **omo's multi-session RPC host** (`omo --mode rpc --multi-session`, JSONL over stdio).

```
Discord  ←→  dorimaki bot (channels · buttons · markdown rendering)
                  ↕
          engine adapter (src/omo/)
                  ↕
   omo --mode rpc --multi-session (JSONL over stdio)  ← your models, your keys
```

## Why

- You like omo (model mixing, favorites, skills) but want to talk to it from Discord like kimaki users do.
- Everything runs **on your machine**: your code, your API keys, your sessions. The default mode is self-hosted — your Discord bot token never leaves your box.

## Install

```bash
# prerequisites: Node.js 22+, omo 5.1.60+ installed and authenticated
curl -fsSL https://get.omo.dev/install.sh | bash
omo auth check --provider <your-provider>   # make sure at least one model works

git clone https://github.com/AndyHong-Productmanager/dorimaki
cd dorimaki
node bin.js
```

dorimaki is not published to npm yet, so run it from a clone. `dist/` is committed, no build step needed.
Set `DORIMAKI_OMO_BIN` if `omo` is not on your `PATH`.

First run walks you through creating a self-hosted Discord bot:

1. Create an app at https://discord.com/developers/applications → **New Application**
2. Bot tab → enable **Message Content Intent** and **Server Members Intent**
3. Copy the bot token into the dorimaki setup wizard
4. Open the printed install URL to invite the bot to your server

## How it works

- Every project directory maps to a Discord **channel**; every agent session is a **thread**.
- One `omo --mode rpc --multi-session` process serves every thread. Each thread is an omo session whose transcript lives in `~/.dorimaki/omo-sessions/<session id>.jsonl`, so sessions survive bot and omo restarts.
- Messages you post in a thread are sent to omo (`prompt`); omo's streaming events are rendered live into Discord messages.
- Interactive tools — action buttons, questions, file uploads, session sleep — are surfaced as native Discord UI.
- Models are omo's: `omo models discover`, your `models.json` favorites, and per-thread `/model` selection all work the omo way.

### Engine mapping

| kimaki (opencode) | dorimaki (omo) |
| --- | --- |
| `opencode serve` HTTP+SSE | `omo --mode rpc --multi-session --session-runtime in-process` (stdio) |
| `session.create` / `session.get` | `open_session { sessionPath, cwd }` |
| `session.promptAsync` | `set_model` (when changed) + `prompt` |
| system prompt / synthetic context | `send_custom_message` (hidden, delivered with the next turn) |
| `session.abort` | `abort` |
| `session.messages` | `get_messages` |
| `session.summarize` | `compact` |
| `provider.list` / `config.get` / `command.list` | `get_available_models` / session default model / `get_commands` |
| SSE `global.event` | `message_*`, `tool_execution_*`, `agent_*` event records |
| permission prompts | `extension_ui_request` select `Permission required: …` → Discord buttons |
| question prompts | `extension_ui_request` `question` / `select` / `confirm` → Discord dropdowns |

## Status

Early development. Works: sessions, streaming text/reasoning/tool parts, model selection, thinking variants, permission and question prompts, abort, history, compaction, session titles, recovery after an omo restart.

omo features in Discord:

- `/model` lists omo's signed-in models, with your omo favorites (`favoriteModels` in omo's `settings.json`, including `:level` suffixes) as a **⭐ Favorites (omo)** entry at the top.
- `/login` signs in to omo's browser (OAuth) providers through `login_start`: pick a provider, open the link, and paste the redirect URL or code when the bot runs headless. API keys are not accepted in Discord; add them with the omo CLI on the bot machine.
- omo skills are slash commands (`/<skill>-skill`), and a curated set of omo commands too (`/goal-cmd`, `/loop-cmd`, `/handoff-cmd`, `/fast-cmd`, `/efforts-cmd`, `/reasoning-cmd`, `/fallback-cmd`, `/tasks-cmd`, `/task-kill-cmd`, `/todo-cmd`, `/remember-cmd`, `/memory-cmd`, `/search-cmd`, `/account-cmd`, `/agreements-cmd`). Their output appears in the thread and menus become Discord dropdowns.

Not supported yet: undo (`revert`/`unrevert`), `fork`, omo `input`/`editor` dialogs outside login (auto-cancelled), and kimaki's OpenCode plugin tools (action buttons, file upload, sleep) which are not registered with omo. See commit history for progress.

## License

MIT. Based on [kimaki](https://github.com/remorses/kimaki) (MIT) by remorses.

# dorimaki

Run your own Discord coding bot against local projects using **omo CLI**.
Each mapped Discord channel represents one project directory. Conversations
run in threads, with a persistent omo session per conversation.

Dorimaki connects your own bot directly to Discord. It does not use Kimaki's
gateway, OpenCode, or a hosted relay. Discord's official Gateway WebSocket is
still used to receive messages.

## Requirements

- Bun 1.3 or newer.
- An installed `omo` CLI with RPC mode, configured with a working model provider.
- Your own Discord application and a server where you can install it.
- A dedicated set of trusted Discord users. They can cause omo to read and
  modify files and run tools with your local account's privileges.

## Install from source

```sh
bun install
bun run build
bun link
dorimaki --help
```

Alternatively, run `bun dist/cli.js` in place of `dorimaki`. The package is not
claimed to be published to a registry.

## Own-bot onboarding

1. Create an application at <https://discord.com/developers/applications>.
2. In **Bot**, enable **Message Content Intent**, then obtain the bot token.
3. Enable Discord Developer Mode to copy your server, channel and user IDs.
4. Run `dorimaki setup`. The wizard prints the bot installation URL, waits for
   installation, verifies the token's application and server access, and saves
   your settings. Use an existing text channel for each project.
5. Map the channel and start:

```sh
dorimaki project add /absolute/path/to/project --channel YOUR_CHANNEL_ID
dorimaki doctor
dorimaki start
```

On Windows, use a quoted path such as `"D:\develop\my-project"`. Choose
`--omo-path` during setup if several omo installations exist.

For noninteractive setup, supply the token through `DISCORD_BOT_TOKEN`, not a
command-line argument:

```sh
dorimaki setup --non-interactive \
  --application YOUR_APPLICATION_ID \
  --guild YOUR_SERVER_ID \
  --users YOUR_USER_ID \
  --omo-path /absolute/path/to/omo
```

Install the bot using the printed URL before retrying setup if server
verification fails. No gateway account, client secret, public web server, or
incoming tunnel is required.

Settings are stored in `~/.dorimaki` by default. Override with
`DORIMAKI_DATA_DIR` or `dorimaki --data-dir /path ...`. `config.json` contains
non-secret settings; `credentials.json` contains the token. Files are created
with owner-only permissions where supported. On Windows, protect that directory
with your account's filesystem ACL. `DISCORD_BOT_TOKEN` overrides the saved
token. Never commit either file.

## Conversations

Send a message or attachment in a mapped project channel to create a thread.
Reply inside the thread to continue the same session. Different threads can run
independently; inputs within one thread are processed in order.

The initial process limit is eight open omo sessions, with up to twenty queued
operations per conversation. Restart the bot to release idle processes when
the session limit is reached; persisted conversations remain resumable.

Only explicitly configured user IDs in the configured server may invoke the
bot. DMs, webhooks and other bots are not accepted. Bot output disables mention
parsing.

| Command | Purpose |
| --- | --- |
| `/new` | Create a fresh conversation thread |
| `/status` | List this project's known session IDs and threads |
| `/session-id` | Show the current thread's session ID |
| `/resume session:...` | Resume a known project session in a new thread; run in the project channel |
| `/fork` | Fork the current thread's latest session state |
| `/stop` | Interrupt the current running turn |
| `/share confirm:true` | Upload the full conversation HTML to the current thread |
| `/agent`, `/command`, `/skill` | Select a loaded catalog entry and supply a prompt |

Catalog shortcuts are registered with kind suffixes where Discord's command
limit permits. Entries are resolved again against the current project's loaded
catalog before invocation.

Catalogs are discovered for mapped projects at startup and refreshed during
conversation activity. Reconnecting reinstalls the desired shortcuts. Entries
that exceed Discord's 100-command limit or collide after name normalization
remain available through the generic autocomplete commands.

`/share` is a Discord attachment, **not** a public website. The transcript is
not automatically redacted: inspect the conversation before confirming. Anyone
who can view the destination thread may see the exported content.

## Local operations

```sh
dorimaki project list
dorimaki doctor --offline
```

Channel mappings are one-to-one with canonical local directories. Resume only
accepts session IDs already recorded for that project, not arbitrary local
paths supplied from Discord. Keep the state directory and omo session files to
preserve history.

Run one bot process per data directory. Stop it with Ctrl+C before changing
configuration or switching machines.

## Development

```sh
bun run typecheck
bun test
bun run build
```

The engine adapter uses an external omo process, not a copied engine. See
[reverse engineering](docs/reverse-engineering.md) for upstream evidence,
observed protocol boundaries and the distinction between source inspection and
live verification.

Live Discord and provider-backed verification require actual credentials.
Passing local tests alone does not establish those integrations work on your
account; consult the verification report for the evidence captured by this
checkout.

### Verified installation distinction

On the development workstation, the global omo 5.1.57 installation supports
HTML export. The desktop-bundled omo 5.1.56 is missing its export template and
fails `/share`. Configure the complete installation explicitly:

```powershell
bun dist/cli.js setup --omo-path "C:\Users\user\.bun\bin\omo.exe"
```

Native approval dialogs are currently cancelled with an explicit error rather
than approved from Discord. Agent delegation uses the loaded native task tool.
Late background results remain subscribed and are routed back to the original
thread. Native result delivery and controlled thread routing are tested; live
Discord QA remains a separate check.

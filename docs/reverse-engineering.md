# Source and runtime evidence

Investigation date: November 4, 2026.

This is a new implementation of the requested workflow, not an OpenCode SDK
compatibility layer. Kimaki's available source was inspected normally. The
REA workflow was used to distinguish installed-artifact observations, source
findings, design choices and unresolved runtime behavior.

## Kimaki source baseline

Repository: <https://github.com/remorses/kimaki>

Inspected commit: `9337b7be068ef1e7d96941fb0ea9533d9250bd17`.
Paths below are relative to that revision:

| Feature | Evidence | Dorimaki adaptation |
| --- | --- | --- |
| Channel/project mapping | `kimaki/src/schema.ts:30-64`, `project.ts:114-165` | Local canonical directory and channel registry |
| Thread creation and bindings | `sessions.ts:386-547` | One persistent omo session per Discord thread |
| Resume and fork | `sessions.ts:676-718,750-836` | Exact omo session file resume and latest-state fork |
| Own-bot onboarding | `credentials.ts:49-61,138-157,378-417` | Only user-owned bot configuration; no proxy mode |
| Authorization and input | `kimaki/src/ingress.ts:44-139,211-220,325-344` | Explicit user allowlist and guild boundary |
| Input attachments | `kimaki/src/prompt.ts:105-143` | Preserve staged originals; native omo media encoding |
| Output attachments | `kimaki/src/effects.ts:108-165` | Direct Discord upload |
| Slash catalog | `kimaki/src/slash-commands.ts:163-179,234-303,398-423,490-539` | Native omo catalogs, deterministic Discord mapping |

OpenCode-specific limits, SDK methods, event names and image schemas were not
treated as omo contracts. Kimaki's `critique --web` flow shares a git diff,
not a conversation export.

## Installed omo baseline

Desktop executable:

```text
C:/Users/user/AppData/Local/Programs/omo/resources/omo-runtime/win32-x64/omo.exe
omo 5.1.56 (engine: senpi 2026.10.30-1)
```

The PATH wrapper reported omo 5.1.57. These are different installations; the
configured executable must be explicit when reproducing results.

Shipped source evidence:

- `plugin/extensions/omo-thread-client.js`: prompt, interrupt, state, messages
  and session wrappers. SHA-256:
  `4c82466ef9cace9b0aec91ba67621598a74ef733db166ec4d1d834427d12d0e3`.
- `plugin/runtime/thread-sdk/sdk.js`: incremental UTF-8 NDJSON framing,
  correlation IDs, error responses and timeouts.
- Runtime package version: `2026.10.30-1`.

Initial isolated probes actually exercised:

```text
omo --mode rpc --session-id <exact UUID>
omo --mode rpc --session <exact session file>
omo --mode rpc --fork <exact session file>
```

Requests `get_protocol_info`, `get_state`, `get_messages`, `get_commands`,
and `get_loaded_surfaces` established the stdio protocol. A response uses
`type:"response"`, `command`, `success`, the request `id`, and either `data`
or error fields. Multi-session routing IDs differ from persistent session IDs;
the initial implementation avoids that additional ownership lifecycle.

The isolated discovery account had no model credentials. Its rejected prompt
does not establish successful model execution or media ingestion. Successful
adapter probes, tests and remaining live gates belong in the implementation
verification report, not retroactively in the discovery record.

## Design choices

- Official Discord Gateway connection with the user's own application, as
  explicitly selected by the user. No third-party gateway.
- Bun-based CLI and SQLite state; omo remains separately installed.
- Explicit operator allowlist rather than implicit server-wide access.
- Exact recorded session files rather than fuzzy ID selection from Discord.
- Latest-state fork, not an unverified fork-before-message API.
- Explicitly confirmed HTML export uploaded to the same thread. Public URL
  hosting and automatic redaction are not claimed.
- Native source and observed behavior govern catalog and media encoding;
  unavailable APIs must produce explicit errors, never success-shaped no-ops.

REA reference: <https://github.com/morluto/rea>.
Full investigation reports are retained locally in `.omo/research/`.

## Implementation runtime verification

The public adapter was exercised against an actual configured model, not only
an executable fixture. The global installation at
`C:/Users/user/.bun/bin/omo.exe` reported omo 5.1.57 / senpi 2026.10.31-2.
`bun tests/engine/runtime-probe.ts C:/Users/user/.bun/bin/omo.exe` observed:

- A completed text response after native `agent_idle`.
- A verification code read from a real attached text file.
- The color of a valid red PNG identified from the image input.
- Exact session identity on resume and a distinct identity/file on fork.
- Successful native HTML export.

Desktop probes additionally observed loaded catalogs (5 agents, 50 commands,
36 skills), a native `/tasks` invocation, `$skill:programming`, task delegation
to `explore`, and interruption. The initial agent probe missed the eventual
child answer because the parent prompt had already ended. A dedicated
`bun tests/engine/agent-probe.ts C:/Users/user/.bun/bin/omo.exe` reproduced that
failure, then passed after persistent background-event delivery was added.
The child read a randomized file value and the caller received it after the
initial prompt ended. The run printed `AGENT_FINAL_RESULT_PASS` and
`AGENT_PROBE_CLEANED`, exit 0.

The desktop installation's native HTML export failed because
`export-html/template.html` was absent. The complete global installation
succeeded; Dorimaki never silently substitutes one configured executable for
another. Prefer the working global executable on this workstation.

The engine owns a small native extension for loaded task metadata and empty
session persistence. Agent discovery parses the actual loaded task
description, which is version-sensitive. Agent invocation is an instruction
to use the native task tool, not a fabricated RPC agent-selection method.
Blocking native approval dialogs currently fail closed rather than being
automatically approved.

The module verification run passed 85 tests and the full TypeScript check.
The final integrated run after catalog and late-result fixes passed 98 tests,
typecheck, lint and build.
These include subprocess/SQLite/discord.js serialization and filesystem
behavior, but external Discord traffic is intercepted in tests. Live Discord
onboarding, message routing and attachment delivery remain a separate gate.

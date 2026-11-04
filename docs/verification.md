# Verification ledger

November 4, 2026, Windows x64, Bun 1.4.4.

## Passed

| Surface | Invocation/evidence | Result |
| --- | --- | --- |
| Integrated checks | `bun run typecheck && bun test && bun run lint && bun run build` | Exit 0; 98 tests, 0 failures; 21 bundled modules |
| Built CLI | `bun dist/cli.js --help` and `setup --help` | Usable commands and options rendered |
| Missing configuration | Built CLI `doctor --offline` against a new empty data path | Expected exit 1 with setup instruction |
| Native text/file/image | `bun tests/engine/runtime-probe.ts C:/Users/user/.bun/bin/omo.exe` | Model response, file-only value and red-image interpretation observed |
| Native session lifecycle | Same runtime probe and `persistence-probe.ts` | Exact resume, distinct fork and preserved empty-session files |
| Native HTML export | Global omo runtime/persistence probes | Export created; decoded session payload contains conversation data |
| Native loaded agent | `bun tests/engine/agent-probe.ts C:/Users/user/.bun/bin/omo.exe` | `AGENT_FINAL_RESULT_PASS`, `AGENT_PROBE_CLEANED`, exit 0 |
| Pack | `bun pm pack --destination artifacts` | `dorimaki-0.1.0.tgz` created |
| Clean installation | `bun add D:/develop/dorimaki/artifacts/dorimaki-0.1.0.tgz` in a new temporary project | Installed with `dorimaki` binary |
| Installed CLI | Installed `dist/cli.js --help`, `setup --help`, `doctor --offline`, `project add`, `project list` | Exit 0; actual omo 5.1.57 reported; canonical mapping persisted across processes |
| Invalid Discord credential | Installed `doctor` with a deliberately invalid test token | Expected exit 1; actionable authentication error, token value not printed |

Temporary installation and fake credentials belong only to the task's private
temporary root, not the user's actual bot configuration.

## Regressions caught and fixed

- A second resume selected a historical thread and left the current session
  writer open. The failing app test reported `Session already has a writer`.
  Resume now chooses and serializes against the active binding.
- A loaded 91-entry catalog plus ten fixed commands exceeded Discord's
  100-command limit. Registration now installs a deterministic fitting subset;
  omitted entries remain accessible through generic autocomplete.
- Native task delegation returned an initial acknowledgement before the
  child answer. The first real agent probe failed. Session-level continuation
  events now remain subscribed and route the late result to its source thread.
  The repeated native probe passed with a child-read randomized file value.
- Gateway reconnect previously did not refresh shortcuts. A real discord.js
  event/REST serialization test now checks re-registration.

## Still requiring the operator's real test bot

The user selected local setup through the wizard. No real bot token was
available during the checks above. These remain unverified:

- Successful interactive setup against the user's application and server.
- Live Gateway message reception and visible thread creation.
- Actual Discord command visibility, attachments and HTML upload.
- End-to-end restart/resume/fork behavior as seen in the Discord client.

Discord tests exercise actual discord.js objects and payload serialization
with login and REST intercepted. Media tests exercise real filesystem writes
with deterministic network responses. These are not presented as live Discord
proof.

## Known boundaries

The desktop-bundled omo 5.1.56 on this workstation lacks its native HTML export
template. The explicitly configured global omo 5.1.57 succeeds. Dorimaki does
not alter either installation or silently swap executables.

Native interactive approval dialogs fail closed with an explicit error.
Conversation sharing is an explicitly confirmed, unredacted HTML attachment
in the current thread, not a publicly hosted page.

No package was published and no remote repository was pushed.

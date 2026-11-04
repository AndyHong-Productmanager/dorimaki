import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createEngine } from "../../src/engine";
import type { EngineSession } from "../../src/contracts";

const root = await mkdtemp(join(tmpdir(), "dorimaki-runtime-"));
const engine = createEngine({
  applicationId: "probe", guildId: "probe", allowedUserIds: [], token: "unused",
  omoPath: process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? Bun.which("omo") ?? "omo",
  dataDir: join(root, "data"),
});
let active: EngineSession | undefined;
async function prompt(text: string, attachments: Parameters<EngineSession["prompt"]>[0]["attachments"] = []) {
  if (!active) throw new Error("No probe session");
  let output = "";
  const events: string[] = [];
  await active.prompt({ text, attachments, onEvent(event) {
    events.push(event.kind);
    if (event.kind === "text") output += event.text;
    if (event.kind === "error") console.log("TURN_ERROR", event.message);
  } });
  console.log("TURN", JSON.stringify({ output, events: Object.fromEntries([...new Set(events)].map((kind) => [kind, events.filter((event) => event === kind).length])) }));
  return output;
}
function pngChunk(type: string, bytes: Buffer): Buffer {
  const name = Buffer.from(type);
  const crcBytes = Buffer.concat([name, bytes]);
  let crc = 0xffffffff;
  for (const byte of crcBytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length, 0);
  name.copy(chunk, 4);
  bytes.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
try {
  console.log("VERSION", await engine.version());
  active = await engine.open({ directory: root, mode: { kind: "create" } });
  const identity = active.identity;
  console.log("CREATE", JSON.stringify(identity));
  const catalog = await active.catalog();
  console.log("CATALOG", JSON.stringify({
    agents: catalog.filter((entry) => entry.kind === "agent").map((entry) => entry.name),
    commands: catalog.filter((entry) => entry.kind === "command").length,
    skills: catalog.filter((entry) => entry.kind === "skill").length,
    examples: catalog.filter((entry) => ["explore", "tasks", "programming"].includes(entry.name)),
  }));
  if (!(await prompt("Reply with exactly DORIMAKI_ENGINE_OK. Do not call tools.")).includes("DORIMAKI_ENGINE_OK")) throw new Error("Missing text probe sentinel");
  const note = join(root, "note.txt");
  await writeFile(note, "The attachment verification code is DORIMAKI_FILE_7291.\n");
  if (!(await prompt("Read the attached local file and reply with its verification code.", [{ path: note, name: "note.txt", contentType: "text/plain" }])).includes("DORIMAKI_FILE_7291")) throw new Error("Provider did not read the attached file");
  const image = join(root, "square.png");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(32 * (32 * 3 + 1));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rows[y * 97 + 1 + x * 3] = 255;
  await writeFile(image, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0)),
  ]));
  if (!/\bred\b/i.test(await prompt("What color fills the attached square? Answer with the color only.", [{ path: image, name: "square.png", contentType: "image/png" }]))) throw new Error("Provider did not identify the attached image");
  if (process.argv.includes("--catalog-invocations")) {
    for (const [kind, name, request] of [
      ["command", "tasks", ""],
      ["skill", "programming", "Reply with DORIMAKI_SKILL_OK. No code changes are requested."],
      ["agent", "explore", "Inspect only the top-level file names in this temporary project and return DORIMAKI_AGENT_OK. Make no edits."],
    ]) {
      const entry = catalog.find((item) => item.kind === kind && item.name === name);
      if (!entry) throw new Error(`Missing loaded ${kind} ${name}`);
      await prompt(`${entry.invocation} ${request}`);
      console.log("INVOKED", kind, name);
    }
  }
  if (process.argv.includes("--interrupt")) {
    const started = Promise.withResolvers<void>();
    const pending = active.prompt({
      text: "Count upward from 1, one integer per line, through 10000. No tools.",
      attachments: [],
      onEvent(event) { if (event.kind === "text") started.resolve(); },
    }).then(() => ({ outcome: "completed" }), (error: unknown) => ({ outcome: error instanceof Error ? error.message : String(error) }));
    await started.promise;
    await active.interrupt();
    console.log("INTERRUPT", JSON.stringify(await pending));
  }
  await active.close();
  active = await engine.open({ directory: root, mode: { kind: "resume", sessionFile: identity.sessionFile } });
  console.log("RESUME", JSON.stringify({ sameId: active.identity.sessionId === identity.sessionId, sameFile: active.identity.sessionFile === identity.sessionFile }));
  await active.close();
  active = await engine.open({ directory: root, mode: { kind: "fork", sessionFile: identity.sessionFile } });
  console.log("FORK", JSON.stringify({ distinctId: active.identity.sessionId !== identity.sessionId, distinctFile: active.identity.sessionFile !== identity.sessionFile }));
  await active.close();
  active = undefined;
  const html = join(root, "export.html");
  await engine.exportHtml(identity.sessionFile, html);
  const payload = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=\s]+)<\/script>/.exec(await readFile(html, "utf8"))?.[1];
  if (!payload) throw new Error("Native HTML export has no session payload");
  const containsReply = Buffer.from(payload, "base64").toString("utf8").includes("DORIMAKI_ENGINE_OK");
  if (!containsReply) throw new Error("Native HTML export lost the assistant reply");
  console.log("EXPORT", JSON.stringify({ containsReply }));
} finally {
  await active?.close();
  await rm(root, { recursive: true, force: true });
  console.log("PROBE_CLEANED");
}

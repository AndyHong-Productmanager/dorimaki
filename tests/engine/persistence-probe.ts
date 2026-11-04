import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../../src/engine";
import { childEnvironment, RpcProcess } from "../../src/engine/rpc";
import type { EngineSession } from "../../src/contracts";

const root = await mkdtemp(join(tmpdir(), "dorimaki-empty-"));
const exe = process.argv[2] ?? Bun.which("omo") ?? "omo";
const engine = createEngine({
  applicationId: "probe", guildId: "probe", allowedUserIds: [], token: "unused",
  omoPath: exe,
  dataDir: join(root, "data"),
});
let active: EngineSession | undefined;
try {
  active = await engine.open({ directory: root, mode: { kind: "create" } });
  const identity = active.identity;
  await active.close();
  console.log("EMPTY_PERSISTED", (await stat(identity.sessionFile)).isFile());
  active = await engine.open({ directory: root, mode: { kind: "resume", sessionFile: identity.sessionFile } });
  console.log("EMPTY_RESUME", active.identity.sessionId === identity.sessionId);
  await active.close();
  active = await engine.open({ directory: root, mode: { kind: "fork", sessionFile: identity.sessionFile } });
  console.log("EMPTY_FORK", active.identity.sessionId !== identity.sessionId);
  await active.close();
  active = undefined;
  const native = new RpcProcess([exe, "--mode", "rpc", "--session", identity.sessionFile], root);
  try {
    await native.request("append_user_message", { content: "DORIMAKI_EXPORT_7291" });
  } finally {
    await native.close();
  }
  const html = join(root, "empty.html");
  try {
    await engine.exportHtml(identity.sessionFile, html);
  } catch (error) {
    const child = Bun.spawn([
      exe,
      "--export", identity.sessionFile, html,
    ], { env: childEnvironment(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log("EXPORT_DIAGNOSTIC", JSON.stringify({ code, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1500) }));
    throw error;
  }
  const content = await readFile(html, "utf8");
  const payload = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=\s]+)<\/script>/.exec(content)?.[1];
  if (!payload) throw new Error("Native HTML export has no session payload");
  const preserved = Buffer.from(payload, "base64").toString("utf8").includes("DORIMAKI_EXPORT_7291");
  if (!preserved) throw new Error("Native HTML export lost conversation content");
  console.log("NONEMPTY_EXPORT", preserved);
} finally {
  await active?.close();
  await rm(root, { recursive: true, force: true });
  console.log("PROBE_CLEANED");
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../../src/engine";
import type { EngineSession } from "../../src/contracts";

const root = await mkdtemp(join(tmpdir(), "dorimaki-agent-"));
const secret = `AGENT_RESULT_${crypto.randomUUID()}`;
const engine = createEngine({
  applicationId: "probe", guildId: "probe", allowedUserIds: [], token: "unused",
  omoPath: process.argv[2] ?? Bun.which("omo") ?? "omo", dataDir: join(root, "data"),
});
let session: EngineSession | undefined;
try {
  await writeFile(join(root, "agent-result.txt"), secret);
  session = await engine.open({ directory: root, mode: { kind: "create" } });
  const agent = (await session.catalog()).find((entry) => entry.kind === "agent" && entry.name === "explore");
  if (!agent) throw new Error("Loaded explore agent missing");
  let output = "";
  let delegated = false;
  const completed = Promise.withResolvers<void>();
  const deadline = setTimeout(() => completed.reject(new Error("Agent final result exceeded five minutes")), 300_000);
  const unsubscribe = session.onBackgroundEvent((event) => {
    if (event.kind === "text") output += event.text;
    if (event.kind === "end" && output.includes(secret)) completed.resolve();
    if (event.kind === "error") completed.reject(new Error(event.message));
  });
  try {
  await session.prompt({
    text: `${agent.invocation} Read agent-result.txt in ${root} and return its exact contents. Do not edit files. The parent must not read the file itself.`,
    attachments: [],
    onEvent(event) {
      if (event.kind === "text") output += event.text;
      if (event.kind === "activity" && event.text === "Running task") delegated = true;
      if (event.kind === "error") console.log("AGENT_ERROR", event.message);
    },
  });
  if (output.includes(secret)) completed.resolve();
  await completed.promise;
  if (!delegated) throw new Error("Final output did not involve the task tool");
  console.log("AGENT_FINAL_RESULT_PASS");
  } finally {
    clearTimeout(deadline);
    unsubscribe();
  }
} finally {
  await session?.close();
  await rm(root, { recursive: true, force: true });
  console.log("AGENT_PROBE_CLEANED");
}

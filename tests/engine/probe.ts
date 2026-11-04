// Explicit manual probe, not part of the automated test suite.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcProcess, childEnvironment } from "../../src/engine/rpc";
import { z } from "zod";

const root = await mkdtemp(join(tmpdir(), "dorimaki-engine-"));
const exe = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? Bun.which("omo") ?? "omo";
const rpc = new RpcProcess([exe, "--mode", "rpc", "--session-dir", join(root, "sessions")], root, childEnvironment());
rpc.onEvent = (frame) => {
  if (["agent_start", "agent_end", "agent_idle", "rpc_error"].includes(String(frame["type"]))) {
    console.log(JSON.stringify({ type: frame["type"], willRetry: frame["willRetry"], aborted: frame["aborted"] }));
  }
};
try {
  const state = await rpc.request("get_state");
  const model = z.object({ provider: z.string(), id: z.string() }).optional().parse(state["model"]);
  console.log("STATE", JSON.stringify({ sessionId: state["sessionId"], sessionFile: state["sessionFile"], model }));
  const commands = await rpc.request("get_commands");
  console.log("COMMANDS", JSON.stringify(z.array(z.object({ name: z.string(), source: z.string(), syntax: z.string() })).parse(commands["commands"])));
  const surfaces = await rpc.request("get_loaded_surfaces");
  console.log("SURFACES", JSON.stringify(z.array(z.object({ name: z.string() })).parse(surfaces["extensions"])));
  const auth = await rpc.request("get_auth_providers");
  console.log("AUTH", JSON.stringify(z.array(z.object({ id: z.string(), status: z.object({ configured: z.boolean(), source: z.string().optional() }) })).parse(auth["providers"]).filter((p) => p.status.configured).map((p) => ({ id: p.id, source: p.status.source }))));
  if (process.argv.includes("--prompt")) {
    const idle = Promise.withResolvers<void>();
    const timer = setTimeout(() => idle.reject(new Error("provider probe turn deadline")), 120_000);
    const previous = rpc.onEvent;
    rpc.onEvent = (frame) => {
      previous(frame);
      const delta = z.object({ type: z.literal("text_delta"), delta: z.string() }).safeParse(frame["assistantMessageEvent"]);
      if (frame["type"] === "message_update" && delta.success) console.log("TEXT", JSON.stringify(delta.data.delta));
      if (frame["type"] === "agent_idle") idle.resolve();
      const failure = z.object({ errorMessage: z.string() }).safeParse(frame["message"]);
      if (frame["type"] === "message_end" && failure.success) console.log("TURN_ERROR", failure.data.errorMessage);
    };
    try {
      console.log("ACCEPT", JSON.stringify(await rpc.request("prompt", { message: "Reply with exactly DORIMAKI_ENGINE_OK. Do not call tools.", clientMessageId: crypto.randomUUID() })));
      await idle.promise;
      console.log("TURN_COMPLETE");
    } finally {
      clearTimeout(timer);
      void idle.promise.catch(() => {});
    }
  }
} finally {
  await rpc.close();
  await rm(root, { recursive: true, force: true });
  console.log("PROBE_CLEANED");
}

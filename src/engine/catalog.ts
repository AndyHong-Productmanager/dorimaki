import { z } from "zod";
import { DorimakiError, type CatalogEntry } from "../contracts";
import type { RpcProcess } from "./rpc";

// This extension runs inside the owned child, using the shipped ExtensionAPI.
// The API exposes loaded tools; omo's task tool describes its effective agents.
export const catalogExtension = `
export default function (pi) {
  pi.rpc.handle("dorimaki.persist", async () => {
    await pi.session.persistHeaderNow();
    pi.appendEntry("dorimaki.binding", { version: 1 });
    return {};
  });
  pi.rpc.handle("dorimaki.catalog", () => {
    const task = pi.getAllTools().find(tool => tool.name === "task");
    return { taskDescription: task ? task.description : null };
  });
}
`;

const commandsSchema = z.object({
  commands: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    source: z.enum(["extension", "prompt", "skill"]),
    syntax: z.enum(["slash", "dollar"]),
  })),
});
const agentsSchema = z.object({ taskDescription: z.string().nullable() });

export async function readCatalog(rpc: RpcProcess): Promise<readonly CatalogEntry[]> {
  const [commands, agents] = await Promise.all([
    rpc.request("get_commands").then((data) => commandsSchema.parse(data)),
    rpc.request("extension_request", { name: "dorimaki.catalog" }).then((data) => agentsSchema.parse(data)),
  ]);
  const entries: CatalogEntry[] = commands.commands.map((command) => ({
    kind: command.source === "skill" ? "skill" : "command",
    name: command.source === "skill" ? command.name.replace(/^skill:/, "") : command.name,
    description: command.description ?? "",
    invocation: `${command.syntax === "dollar" ? "$" : "/"}${command.name}`,
  }));
  if (agents.taskDescription !== null) {
    // Verified in shipped omo-task.js L2: this line is built from enabled,
    // actually loaded agents. Plan-gated agents are a separate line, not shortcuts.
    const names = /(?:^|\n)- subagent_type invokes a loaded agent directly\. Available agents: ([^\n]+)/.exec(agents.taskDescription)?.[1];
    if (names === undefined) {
      throw new DorimakiError("engine_catalog", "Loaded task tool uses an unrecognized agent catalog format");
    }
    if (names !== "none loaded") {
      for (const name of names.split(", ")) {
        entries.push({
          kind: "agent",
          name,
          description: `Delegate to the loaded ${name} agent`,
          invocation: `Use the task tool with subagent_type=${JSON.stringify(name)}, run_in_background=false, and prompt set to the following request. Return the agent's completed result, not a start acknowledgement:\n`,
        });
      }
    }
  }
  return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

import { SlashCommandBuilder } from "discord.js";
import type { CatalogEntry } from "../contracts";

const fixed = ["new", "resume", "fork", "stop", "share", "session-id", "status", "agent", "command", "skill"] as const;
export const isKind = (name: string): name is CatalogEntry["kind"] =>
  name === "agent" || name === "command" || name === "skill";
export const isFixed = (name: string) => fixed.some(value => value === name);
const suffix = { agent: "-agent", command: "-cmd", skill: "-skill" };
const rank = { agent: 0, command: 1, skill: 2 };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function catalogCommands(entries: readonly CatalogEntry[]) {
  const definitions = fixed.map(name => {
    const command = new SlashCommandBuilder().setName(name).setDescription(`Dorimaki ${name}`);
    if (name === "resume") command.addStringOption(o => o.setName("session").setDescription("Session ID to resume").setRequired(true));
    if (name === "share") command.addBooleanOption(o => o.setName("confirm").setDescription("Confirm uploading the unredacted conversation").setRequired(true));
    if (isKind(name)) command.addStringOption(o => o.setName("name").setDescription(`${name} name`).setRequired(true).setAutocomplete(true));
    if (name === "new") command.addStringOption(o => o.setName("name").setDescription("Conversation name"));
    if (isKind(name)) command.addStringOption(o => o.setName("prompt").setDescription("Prompt or arguments"));
    return command.toJSON();
  });
  const shortcuts = new Map<string, CatalogEntry>();
  const omitted: string[] = [];
  const sorted = [...entries].sort((a, b) => rank[a.kind] - rank[b.kind] || compare(a.name, b.name));
  for (const entry of sorted) {
    const ending = suffix[entry.kind];
    const stem = entry.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!stem) { omitted.push(entry.name); continue; }
    const name = stem.slice(0, 32 - ending.length).replace(/-$/, "") + ending;
    if (shortcuts.has(name) || isFixed(name) || definitions.length >= 100) {
      omitted.push(entry.name);
      continue;
    }
    shortcuts.set(name, Object.freeze({ ...entry }));
    definitions.push(new SlashCommandBuilder().setName(name)
      .setDescription(entry.description.trim().slice(0, 100) || `Run ${entry.kind}`)
      .addStringOption(o => o.setName("prompt").setDescription("Prompt or arguments")).toJSON());
  }
  return { definitions, shortcuts, omitted };
}

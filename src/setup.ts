import * as prompts from "@clack/prompts";
import ky from "ky";
import { z } from "zod";
import { settingsSchema, saveSettings } from "./config.js";
import { DorimakiError } from "./contracts.js";
import type { Config } from "./contracts.js";

export const setupOptionsSchema = z.object({
  application: z.string().optional(),
  guild: z.string().optional(),
  users: z.string().optional(),
  omoPath: z.string().optional(),
  nonInteractive: z.boolean().optional(),
});

async function answer(input: {
  readonly value: string | undefined;
  readonly label: string;
  readonly interactive: boolean;
  readonly secret?: boolean;
}): Promise<string> {
  if (input.value) return input.value;
  if (!input.interactive) throw new DorimakiError("setup_missing", `Missing ${input.label}. Supply setup options and DISCORD_BOT_TOKEN.`);
  const value = input.secret
    ? await prompts.password({ message: input.label })
    : await prompts.text({ message: input.label });
  if (prompts.isCancel(value)) throw new DorimakiError("cancelled", "Setup cancelled.");
  return value;
}

export async function verifyBot(config: Pick<Config, "token" | "applicationId" | "guildId">): Promise<void> {
  const client = ky.create({
    prefixUrl: "https://discord.com/api/v10",
    headers: { Authorization: `Bot ${config.token}` },
    timeout: 15_000,
    retry: 0,
  });
  try {
    const application = z.object({ id: z.string() }).parse(
      await client.get("oauth2/applications/@me").json(),
    );
    if (application.id !== config.applicationId) {
      throw new DorimakiError("wrong_application", "Bot token belongs to a different Discord application.");
    }
    await client.get(`guilds/${config.guildId}`);
  } catch (error) {
    if (error instanceof DorimakiError) throw error;
    if (error instanceof Error) {
      throw new DorimakiError("discord_verification", "Discord verification failed. Check bot token, application ID and installation in the selected server.");
    }
    throw error;
  }
}

export async function setup(directory: string, rawOptions: unknown): Promise<void> {
  const options = setupOptionsSchema.parse(rawOptions);
  const interactive = !options.nonInteractive && Boolean(process.stdin.isTTY);
  console.log("Create your own application at https://discord.com/developers/applications");
  console.log("Bot: enable Message Content Intent, then copy the bot token. Never paste it into Discord.");
  const applicationId = await answer({ value: options.application, label: "Application ID", interactive });
  const guildId = await answer({ value: options.guild, label: "Server (guild) ID", interactive });
  const users = await answer({ value: options.users, label: "Allowed Discord user IDs (comma separated)", interactive });
  const token = await answer({ value: process.env["DISCORD_BOT_TOKEN"], label: "Bot token", interactive, secret: true });
  const settings = settingsSchema.parse({
    applicationId,
    guildId,
    allowedUserIds: users.split(",").map((id) => id.trim()).filter(Boolean),
    omoPath: options.omoPath ?? Bun.which("omo") ?? "omo",
  });
  const permissions = (1024n | 2048n | 16384n | 32768n | 34359738368n | 274877906944n).toString();
  console.log(`Install bot: https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${permissions}&guild_id=${guildId}`);
  if (interactive) {
    const installed = await prompts.confirm({ message: "Have you installed the bot in that server?", initialValue: true });
    if (prompts.isCancel(installed) || !installed) throw new DorimakiError("cancelled", "Install the bot, then run setup again.");
  }
  await verifyBot({ token, applicationId, guildId });
  await saveSettings({ directory, settings, token });
  console.log(`Configuration saved in ${directory}. Run dorimaki project add <directory> --channel <id>, then dorimaki start.`);
}

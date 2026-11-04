import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./contracts.js";
import { DorimakiError } from "./contracts.js";

const snowflake = z.string().regex(/^\d{17,22}$/);
export const settingsSchema = z.object({
  applicationId: snowflake,
  guildId: snowflake,
  allowedUserIds: z.array(snowflake).min(1),
  omoPath: z.string().min(1),
});
export type Settings = z.infer<typeof settingsSchema>;

export function dataDirectory(value?: string): string {
  return resolve(value ?? process.env["DORIMAKI_DATA_DIR"] ?? join(homedir(), ".dorimaki"));
}

export async function saveSettings(input: {
  readonly directory: string;
  readonly settings: Settings;
  readonly token: string;
}): Promise<void> {
  const settings = settingsSchema.parse(input.settings);
  if (input.token.trim().length < 20) {
    throw new DorimakiError("invalid_token", "A Discord bot token is required.");
  }
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ["config.json", JSON.stringify(settings, null, 2)],
    ["credentials.json", JSON.stringify({ token: input.token.trim() })],
  ]) {
    if (name === undefined || value === undefined) continue;
    const path = join(input.directory, name);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
}

export async function loadConfig(directory: string): Promise<Config> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  } catch (error) {
    if (error instanceof Error) {
      throw new DorimakiError("config_missing", "Cannot read configuration. Run dorimaki setup first.");
    }
    throw error;
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DorimakiError("config_invalid", "Invalid config.json: check applicationId, guildId, allowedUserIds and omoPath.");
  }
  let token = process.env["DISCORD_BOT_TOKEN"]?.trim();
  if (!token) {
    try {
      const secret = z.object({ token: z.string().min(20) }).parse(
        JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")),
      );
      token = secret.token;
    } catch (error) {
      if (error instanceof Error) {
        throw new DorimakiError("token_missing", "Set DISCORD_BOT_TOKEN or run dorimaki setup.");
      }
      throw error;
    }
  }
  return { ...parsed.data, dataDir: directory, token };
}

export function safeError(error: unknown, token?: string): string {
  const message = error instanceof Error ? error.message : "Unexpected failure";
  return token ? message.replaceAll(token, "[redacted]") : message;
}

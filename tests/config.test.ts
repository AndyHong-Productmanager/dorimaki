import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveSettings } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("persists operator policy separately from the bot credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dorimaki-config-"));
  directories.push(directory);
  await saveSettings({
    directory,
    token: "test-token-not-a-real-credential",
    settings: {
      applicationId: "123456789012345678",
      guildId: "223456789012345678",
      allowedUserIds: ["323456789012345678"],
      omoPath: "/explicit/omo",
    },
  });
  const config = await loadConfig(directory);
  expect(config.allowedUserIds).toEqual(["323456789012345678"]);
  expect(config.omoPath).toBe("/explicit/omo");
  expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))).not.toHaveProperty("token");
  expect(JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"))).toEqual({
    token: "test-token-not-a-real-credential",
  });
});

test("rejects an empty allowlist instead of admitting every server member", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dorimaki-config-"));
  directories.push(directory);
  await writeFile(join(directory, "config.json"), JSON.stringify({
    applicationId: "123456789012345678",
    guildId: "223456789012345678",
    allowedUserIds: [],
    omoPath: "omo",
  }));
  await expect(loadConfig(directory)).rejects.toMatchObject({ code: "config_invalid" });
});

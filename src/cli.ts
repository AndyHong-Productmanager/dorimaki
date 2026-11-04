#!/usr/bin/env bun
import { Command } from "commander";
import { z } from "zod";
import { dataDirectory, loadConfig, safeError } from "./config.js";
import { setup, verifyBot } from "./setup.js";
import { openStore } from "./storage/index.js";
import { createEngine } from "./engine/index.js";
import { connectDiscord } from "./discord/index.js";
import { Application } from "./app.js";
import { DorimakiError } from "./contracts.js";

const program = new Command()
  .name("dorimaki")
  .description("Your own Discord coding bot, powered by the local omo CLI")
  .version("0.1.0")
  .option("--data-dir <directory>", "Configuration and session mapping directory");

function directory(): string {
  const options = z.object({ dataDir: z.string().optional() }).parse(program.opts());
  return dataDirectory(options.dataDir);
}

program.command("setup")
  .description("Configure your own Discord bot (no intermediary gateway)")
  .option("--application <id>", "Discord application ID")
  .option("--guild <id>", "Discord server ID")
  .option("--users <ids>", "Allowed user IDs, comma separated")
  .option("--omo-path <executable>", "omo executable path")
  .option("--non-interactive", "Require all options and DISCORD_BOT_TOKEN")
  .action(async (options: unknown) => setup(directory(), options));

program.command("doctor")
  .description("Verify configuration, omo executable and bot installation")
  .option("--offline", "Check local configuration and omo only")
  .action(async (raw: unknown) => {
    const options = z.object({ offline: z.boolean().optional() }).parse(raw);
    const config = await loadConfig(directory());
    const engine = createEngine(config);
    console.log(`omo: ${await engine.version()}`);
    console.log(`Configuration: ${config.dataDir}`);
    console.log(`Allowed users: ${config.allowedUserIds.length}`);
    if (!options.offline) {
      await verifyBot(config);
      console.log("Discord bot application and server access: OK");
    }
  });

const project = program.command("project").description("Manage channel-to-directory mappings");
project.command("add")
  .argument("<directory>", "Existing local project directory")
  .requiredOption("--channel <id>", "Existing Discord text channel ID")
  .description("Bind one existing channel to one local project")
  .action(async (path: string, raw: unknown) => {
    const options = z.object({ channel: z.string().regex(/^\d{17,22}$/) }).parse(raw);
    const config = await loadConfig(directory());
    const store = openStore(config.dataDir);
    try {
      const mapped = await store.addProject({
        directory: path, channelId: options.channel, guildId: config.guildId,
      });
      console.log(JSON.stringify(mapped, null, 2));
    } finally {
      store.close();
    }
  });
project.command("list")
  .description("List local project mappings")
  .action(async () => {
    const config = await loadConfig(directory());
    const store = openStore(config.dataDir);
    try {
      console.log(JSON.stringify(store.projects(), null, 2));
    } finally {
      store.close();
    }
  });

program.command("start")
  .description("Run the directly connected Discord bot")
  .action(async () => {
    const config = await loadConfig(directory());
    const store = openStore(config.dataDir);
    if (store.projects().length === 0) {
      store.close();
      throw new DorimakiError("no_projects", "Map a channel first: dorimaki project add <directory> --channel <id>");
    }
    const engine = createEngine(config);
    console.log(`Using ${await engine.version()}`);
    const ready = Promise.withResolvers<Application>();
    try {
      const discord = await connectDiscord(config, {
        message: async (input) => (await ready.promise).message(input),
        command: async (input) => (await ready.promise).command(input),
        autocomplete: async (input) => (await ready.promise).autocomplete(input),
      });
      const app = new Application({ config, store, engine, discord });
      try {
        await app.initialize();
      } catch (error) {
        await app.close();
        throw error;
      }
      ready.resolve(app);
      console.log("Dorimaki connected. Send a message in a mapped project channel.");
      const stopped = Promise.withResolvers<void>();
      const shutdown = () => stopped.resolve();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      await stopped.promise;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await app.close();
    } catch (error) {
      store.close();
      throw error;
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(safeError(error, process.env["DISCORD_BOT_TOKEN"]));
  process.exitCode = 1;
}

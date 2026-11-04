import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  AttachmentBuilder, ChannelType, Events, MessageFlags,
  type Client, type Interaction, type Message,
} from "discord.js";
import { DorimakiError, type BotHandlers, type CatalogEntry, type Config, type DiscordPort } from "../contracts";
import { catalogCommands, isFixed, isKind } from "./catalog";

const mentions: { parse: []; repliedUser: boolean } = { parse: [], repliedUser: false };

/** Preserve all text and never split a UTF-16 surrogate pair. */
export function chunks(text: string): string[] {
  const result: string[] = [];
  while (text.length) {
    let end = Math.min(text.length, 2000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    result.push(text.slice(0, end));
    text = text.slice(end);
  }
  return result;
}

/** Internal client seam: tests use real discord.js structures with intercepted REST. */
export async function connectClient(client: Client, config: Config, handlers: BotHandlers): Promise<DiscordPort> {
  let closed = false;
  let installed = false;
  let shortcuts = new Map<string, CatalogEntry>();
  let signature = "";
  let registration = Promise.resolve();
  let desiredCatalog: readonly CatalogEntry[] = [];
  const allowed = new Set(config.allowedUserIds);
  const redact = (text: string) => (config.token ? text.replaceAll(config.token, "[REDACTED]") : text)
    .replace(/(Bot|Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/((?:token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
  const failure = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
  const report = (error: unknown) => console.error(`Discord: ${failure(error)}`);
  const authorize = (guild: string | null, user: { id: string; bot: boolean }) =>
    !closed && installed && guild === config.guildId && !user.bot && allowed.has(user.id);
  const ensureOpen = () => {
    if (closed) throw new DorimakiError("transport_closed", "Discord connection is closed.");
  };
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { ensureOpen(); return await work(); }
    catch (error) { throw new DorimakiError(error instanceof DorimakiError ? error.code : "discord_error", failure(error)); }
  }
  async function channel(id: string) {
    const found = await client.channels.fetch(id);
    if (!found || !("guildId" in found) || found.guildId !== config.guildId || !found.isSendable())
      throw new DorimakiError("invalid_channel", "Destination must be a sendable channel in the configured guild.");
    return found;
  }
  const port: DiscordPort = {
    async createThread(input) {
      return guarded(async () => {
        const parent = await channel(input.channelId);
        if (parent.type !== ChannelType.GuildText && parent.type !== ChannelType.GuildAnnouncement)
          throw new DorimakiError("invalid_channel", "Threads must start in a guild text or announcement channel.");
        const name = Array.from(redact(input.name).trim()).slice(0, 100).join("") || "Dorimaki";
        if (input.messageId) return (await (await parent.messages.fetch(input.messageId)).startThread({ name })).id;
        if (parent.type !== ChannelType.GuildText)
          throw new DorimakiError("invalid_channel", "Announcement threads require a triggering message.");
        return (await parent.threads.create({ name, type: ChannelType.PublicThread })).id;
      });
    },
    async send(id, text) {
      return guarded(async () => {
        const target = await channel(id);
        for (const content of chunks(redact(text))) await target.send({ content, allowedMentions: mentions });
      });
    },
    async upload(id, paths) {
      return guarded(async () => {
        const target = await channel(id);
        // Validate every path before making the first externally visible upload.
        for (const path of paths) {
          if (!(await stat(path)).isFile()) throw new DorimakiError("invalid_file", "Upload path must be a regular file.");
        }
        for (let i = 0; i < paths.length; i += 10) {
          const files = await Promise.all(paths.slice(i, i + 10).map(async path =>
            new AttachmentBuilder(await readFile(path), { name: basename(path) })));
          await target.send({ files, allowedMentions: mentions });
        }
      });
    },
    async registerCatalog(entries) {
      // Snapshot caller-owned data before the queued operation can run.
      const snapshot = entries.map(entry => ({ ...entry }));
      desiredCatalog = snapshot;
      const operation = registration.then(() => guarded(async () => {
        const next = catalogCommands(snapshot);
        const nextSignature = JSON.stringify(next.definitions);
        if (signature !== nextSignature) {
          if (!client.application || client.application.id !== config.applicationId)
            throw new DorimakiError("application_mismatch", "Logged-in bot does not match the configured application.");
          await client.application.commands.set(next.definitions, config.guildId);
          signature = nextSignature;
          if (next.omitted.length) console.warn(`Discord: ${next.omitted.length} catalog shortcuts omitted by naming/size limits; use /agent, /command or /skill autocomplete.`);
        }
        shortcuts = next.shortcuts;
      }));
      // The caller receives rejection; recovery of the queue is not error suppression.
      registration = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      installed = false;
      client.off(Events.MessageCreate, onMessage);
      client.off(Events.InteractionCreate, onInteraction);
      client.off(Events.ShardResume, onReconnect);
      client.off(Events.ClientReady, onReconnect);
      await registration;
      await client.destroy();
      client.off(Events.Error, report);
    },
  };
  async function handleMessage(message: Message) {
    if (!authorize(message.guildId, message.author) || message.webhookId || message.system) return;
    try {
      await handlers.message(Object.freeze({
        messageId: message.id, userId: message.author.id, guildId: config.guildId,
        channelId: message.channelId,
        parentChannelId: message.channel.isThread() ? message.channel.parentId : null,
        text: message.content,
        attachments: Object.freeze([...message.attachments.values()].map(file => Object.freeze({
          url: file.url, name: file.name, size: file.size, contentType: file.contentType,
        }))),
      }));
    } catch (error) {
      await port.send(message.channelId, `Unable to process message: ${failure(error)}`);
    }
  }
  async function handleInteraction(interaction: Interaction) {
    if (!interaction.guildId || !interaction.channelId || interaction.user.bot) return;
    if (!authorize(interaction.guildId, interaction.user)) {
      if (interaction.isAutocomplete()) await interaction.respond([]);
      else if (interaction.isChatInputCommand()) await interaction.reply({
        content: "Access denied.", flags: MessageFlags.Ephemeral, allowedMentions: mentions,
      });
      return;
    }
    const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null;
    if (interaction.isAutocomplete()) {
      try {
        if (!isKind(interaction.commandName) || interaction.options.getFocused(true).name !== "name") {
          await interaction.respond([]); return;
        }
        const entries = await handlers.autocomplete({
          channelId: interaction.channelId, parentChannelId,
          kind: interaction.commandName, query: interaction.options.getFocused(),
        });
        const seen = new Set<string>();
        await interaction.respond(entries.filter(entry => {
          if (entry.kind !== interaction.commandName || !entry.name || entry.name.length > 100 || seen.has(entry.name)) return false;
          seen.add(entry.name); return true;
        }).slice(0, 25).map(entry => ({ name: redact(entry.name).slice(0, 100), value: entry.name })));
      } catch (error) {
        report(error);
        if (!interaction.responded) await interaction.respond([]);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let replied = false;
    const reply = async (text: string) => {
      for (const content of chunks(redact(text || "Done."))) {
        if (!replied) {
          await interaction.editReply({ content, allowedMentions: mentions });
          replied = true;
        } else await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: mentions });
      }
    };
    try {
      const shortcut = shortcuts.get(interaction.commandName);
      if (!shortcut && !isFixed(interaction.commandName)) throw new DorimakiError("unknown_command", "This command is no longer registered.");
      const options: Record<string, string> = {};
      for (const option of interaction.options.data) {
        if (typeof option.value === "string" || typeof option.value === "boolean") options[option.name] = String(option.value);
      }
      if (shortcut) options["name"] = shortcut.name;
      await handlers.command(Object.freeze({
        name: shortcut?.kind ?? interaction.commandName, userId: interaction.user.id,
        guildId: config.guildId, channelId: interaction.channelId, parentChannelId,
        options: Object.freeze(options), reply,
      }));
      if (!replied) await reply("Done.");
    } catch (error) { await reply(`Command failed: ${failure(error)}`); }
  }
  const onMessage = (message: Message) => { void handleMessage(message).catch(report); };
  const onInteraction = (interaction: Interaction) => { void handleInteraction(interaction).catch(report); };
  const onReconnect = () => {
    if (!installed || closed) return;
    signature = "";
    void port.registerCatalog(desiredCatalog).catch(report);
  };
  client.on(Events.Error, report);
  client.on(Events.MessageCreate, onMessage);
  client.on(Events.InteractionCreate, onInteraction);
  client.on(Events.ShardResume, onReconnect);
  client.on(Events.ClientReady, onReconnect);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readyListener: (() => void) | undefined;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      readyListener = resolve;
      client.once(Events.ClientReady, readyListener);
      timer = setTimeout(() => reject(new DorimakiError("discord_timeout", "Discord did not become ready within 30 seconds.")), 30_000);
    });
    await Promise.all([ready, client.login(config.token)]);
    await port.registerCatalog([]);
    installed = true;
    return port;
  } catch (error) {
    await port.close();
    throw new DorimakiError("discord_connect", failure(error));
  } finally {
    clearTimeout(timer);
    if (readyListener) client.off(Events.ClientReady, readyListener);
  }
}

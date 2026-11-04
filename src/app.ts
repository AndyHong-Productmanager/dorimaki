import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { CatalogEntry, CommandInput, MessageInput } from "./contracts.js";
import { DorimakiError } from "./contracts.js";
import { Conversations, type Dependencies } from "./conversations.js";
import { ConversationQueue } from "./queue.js";
import { stageAttachments } from "./media/index.js";
import { createShare } from "./share/index.js";
import { safeError } from "./config.js";
import { Catalogs } from "./catalogs.js";

export class Application {
  private readonly conversations: Conversations;
  private readonly queue = new ConversationQueue();
  private readonly catalogs: Catalogs;
  private closing = false;

  constructor(private readonly dependencies: Dependencies) {
    this.catalogs = new Catalogs(dependencies);
    this.conversations = new Conversations(dependencies, (project, session) => this.catalogs.refresh(project, session));
  }

  async initialize(): Promise<void> {
    await this.catalogs.initialize();
  }

  private authorize(userId: string, guildId: string): void {
    if (this.closing) throw new DorimakiError("closing", "Dorimaki is shutting down.");
    if (guildId !== this.dependencies.config.guildId ||
        !this.dependencies.config.allowedUserIds.includes(userId)) {
      throw new DorimakiError("unauthorized", "You are not authorized to use this local coding bot.");
    }
  }

  async message(input: MessageInput): Promise<void> {
    this.authorize(input.userId, input.guildId);
    const project = this.conversations.project(input.channelId, input.parentChannelId);
    if (!this.dependencies.store.claimMessage(input.messageId)) return;
    let destination = input.channelId;
    try {
      if (input.parentChannelId === null) {
        destination = await this.queue.run(input.channelId, async () => {
          this.authorize(input.userId, input.guildId);
          return this.conversations.create({
            project, name: input.text || "Attachment conversation", messageId: input.messageId,
          });
        });
      }
      await this.queue.run(destination, async () => {
        this.authorize(input.userId, input.guildId);
        this.conversations.binding(destination);
        const attachments = await stageAttachments({
          dataDir: this.dependencies.config.dataDir,
          messageId: input.messageId, files: input.attachments,
        });
        const session = await this.conversations.session(destination);
        let response = "";
        let failure: string | undefined;
        await session.prompt({
          text: input.text, attachments,
          onEvent: (event) => {
            switch (event.kind) {
              case "text": response += event.text; break;
              case "error": failure = event.message; break;
              case "activity": case "end": case "catalog-changed": break;
            }
          },
        });
        if (failure) throw new DorimakiError("turn_failed", failure);
        await this.dependencies.discord.send(destination, response || "Turn completed without a text response.");
        try {
          await this.catalogs.refresh(project, session);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          console.error(`Catalog refresh failed: ${safeError(error, this.dependencies.config.token)}`);
        }
        this.dependencies.store.finishMessage(input.messageId, "completed");
      });
    } catch (error) {
      this.dependencies.store.finishMessage(input.messageId, "uncertain");
      await this.dependencies.discord.send(destination, `Error: ${safeError(error, this.dependencies.config.token)}`);
    }
  }

  async command(input: CommandInput): Promise<void> {
    this.authorize(input.userId, input.guildId);
    const project = this.conversations.project(input.channelId, input.parentChannelId);
    if (input.name === "stop") {
      await this.conversations.interrupt(input.channelId);
      await input.reply("Interrupt requested.");
      return;
    }
    await this.queue.run(input.channelId, async () => {
      this.authorize(input.userId, input.guildId);
      switch (input.name) {
        case "new": {
          const thread = await this.conversations.create({ project, name: input.options["name"] ?? "New omo session" });
          await this.catalogs.refresh(project, await this.conversations.session(thread));
          await input.reply(`Session created: <#${thread}>`);
          return;
        }
        case "resume": {
          if (input.parentChannelId !== null) {
            throw new DorimakiError("project_channel_required", "Run /resume in the project channel, not in a session thread.");
          }
          const id = input.options["session"];
          const candidates = this.dependencies.store.conversations(project.id).filter((item) => item.sessionId === id);
          const source = candidates.find((item) => item.active) ?? candidates.at(-1);
          if (!source) throw new DorimakiError("session_missing", "Use /status to find a session ID for this project.");
          const thread = await this.queue.run(source.threadId, () =>
            this.conversations.create({ project, name: `Resume ${source.sessionId}`, source }));
          await input.reply(`Session resumed: <#${thread}>`);
          return;
        }
        case "fork": {
          const source = this.conversations.binding(input.channelId);
          const thread = await this.conversations.create({ project, source, fork: true, name: `Fork ${source.sessionId}` });
          await input.reply(`Session forked: <#${thread}>`);
          return;
        }
        case "session-id":
          await input.reply(this.conversations.binding(input.channelId).sessionId);
          return;
        case "status":
          await input.reply(this.dependencies.store.conversations(project.id)
            .map((item) => `${item.active ? "active" : "historical"} \`${item.sessionId}\` <#${item.threadId}>`).join("\n") || "No sessions yet.");
          return;
        case "share": {
          if (input.options["confirm"] !== "true") {
            await input.reply("Sharing uploads the complete, potentially sensitive transcript to this thread. Run /share confirm:true to proceed.");
            return;
          }
          const binding = this.conversations.binding(input.channelId);
          const path = await createShare({
            engine: this.dependencies.engine, sessionFile: binding.sessionFile,
            dataDir: this.dependencies.config.dataDir,
          });
          try {
            await this.dependencies.discord.upload(input.channelId, [path]);
          } finally {
            await rm(dirname(path), { recursive: true, force: true });
          }
          await input.reply("Conversation HTML uploaded to this thread (not publicly published or automatically redacted).");
          return;
        }
        default:
          await this.invoke(input);
      }
    });
  }

  private async invoke(input: CommandInput): Promise<void> {
    const project = this.conversations.project(input.channelId, input.parentChannelId);
    const threadId = input.parentChannelId === null
      ? await this.conversations.create({ project, name: `${input.name}: ${input.options["name"] ?? "invocation"}` })
      : input.channelId;
    const session = await this.conversations.session(threadId);
    await this.catalogs.refresh(project, session);
    const entries = await session.catalog();
    const entry = entries.find((item) => item.kind === input.name && item.name === input.options["name"]);
    if (!entry) throw new DorimakiError("catalog_missing", "That agent, command or skill is not loaded in this project session.");
    let response = "";
    await session.prompt({
      text: `${entry.invocation} ${input.options["prompt"] ?? ""}`.trim(),
      attachments: [],
      onEvent: (event) => { if (event.kind === "text") response += event.text; },
    });
    if (response) await this.dependencies.discord.send(threadId, response);
    await input.reply(`Invocation submitted in <#${threadId}>. Follow-up results will appear there.`);
  }

  async autocomplete(input: {
    readonly channelId: string;
    readonly parentChannelId: string | null;
    readonly kind: CatalogEntry["kind"];
    readonly query: string;
  }): Promise<readonly CatalogEntry[]> {
    const project = this.conversations.project(input.channelId, input.parentChannelId);
    const entries = input.parentChannelId === null
      ? this.catalogs.entries(project.id)
      : await (await this.conversations.session(input.channelId)).catalog();
    return entries.filter((item) =>
      item.kind === input.kind && item.name.toLowerCase().includes(input.query.toLowerCase())).slice(0, 25);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.conversations.interruptAll();
    await this.queue.drain();
    await this.conversations.close();
    await this.dependencies.discord.close();
    this.dependencies.store.close();
  }
}

import type {
  Config, Conversation, DiscordPort, Engine, EngineSession, Project, Store,
} from "./contracts.js";
import { DorimakiError } from "./contracts.js";
import { safeError } from "./config.js";

export type Dependencies = {
  readonly config: Config;
  readonly store: Store;
  readonly engine: Engine;
  readonly discord: DiscordPort;
};

export class Conversations {
  private readonly sessions = new Map<string, EngineSession>();
  private readonly unsubscribe = new Map<string, () => void>();
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(
    readonly dependencies: Dependencies,
    private readonly catalogChanged: (project: Project, session: EngineSession) => Promise<void>,
  ) {}

  private observe(threadId: string, project: Project, session: EngineSession): void {
    let text = "";
    const enqueue = (action: () => Promise<void>) => {
      const pending = (this.deliveries.get(threadId) ?? Promise.resolve()).then(action).catch((error: unknown) => {
        console.error(`Background delivery: ${safeError(error, this.dependencies.config.token)}`);
      });
      this.deliveries.set(threadId, pending);
    };
    this.unsubscribe.set(threadId, session.onBackgroundEvent((event) => {
      switch (event.kind) {
        case "text": text += event.text; break;
        case "error": text += `\nError: ${event.message}`; break;
        case "end": {
          const output = text;
          text = "";
          if (output) enqueue(() => this.dependencies.discord.send(threadId, output));
          break;
        }
        case "catalog-changed": enqueue(() => this.catalogChanged(project, session)); break;
        case "activity": break;
      }
    }));
  }

  project(channelId: string, parentChannelId: string | null): Project {
    const project = this.dependencies.store.project(parentChannelId ?? channelId);
    if (!project) throw new DorimakiError("unmapped_project", "Map this channel with dorimaki project add first.");
    return project;
  }

  binding(threadId: string): Conversation {
    const binding = this.dependencies.store.conversation(threadId);
    if (!binding?.active) throw new DorimakiError("inactive_session", "This thread has no active session. Use /resume in its project channel.");
    return binding;
  }

  async session(threadId: string): Promise<EngineSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const binding = this.binding(threadId);
    const project = this.dependencies.store.projects().find((item) => item.id === binding.projectId);
    if (!project) throw new DorimakiError("unmapped_project", "Session project no longer exists.");
    this.checkCapacity();
    const opened = await this.dependencies.engine.open({
      directory: project.directory,
      mode: { kind: "resume", sessionFile: binding.sessionFile },
    });
    if (opened.identity.sessionId !== binding.sessionId) {
      await opened.close();
      throw new DorimakiError("session_mismatch", "omo resumed a different session; no prompt was sent.");
    }
    this.sessions.set(threadId, opened);
    this.observe(threadId, project, opened);
    return opened;
  }

  async create(input: {
    readonly project: Project;
    readonly name: string;
    readonly messageId?: string;
    readonly source?: Conversation;
    readonly fork?: boolean;
  }): Promise<string> {
    if (input.source && input.source.projectId !== input.project.id) {
      throw new DorimakiError("wrong_project", "Cannot open a session belonging to another project.");
    }
    if (input.source && !input.fork) await this.release(input.source.threadId);
    this.checkCapacity();
    const session = await this.dependencies.engine.open({
      directory: input.project.directory,
      mode: input.source
        ? { kind: input.fork ? "fork" : "resume", sessionFile: input.source.sessionFile }
        : { kind: "create" },
    });
    try {
      if (input.source && (input.fork
        ? session.identity.sessionId === input.source.sessionId
        : session.identity.sessionId !== input.source.sessionId)) {
        throw new DorimakiError("session_mismatch", "omo returned an unexpected session identity.");
      }
      const threadId = await this.dependencies.discord.createThread({
        channelId: input.project.channelId,
        name: input.name.slice(0, 90) || "New omo session",
        ...(input.messageId ? { messageId: input.messageId } : {}),
      });
      this.dependencies.store.bind({
        threadId, projectId: input.project.id,
        ...session.identity, active: true,
      });
      this.sessions.set(threadId, session);
      this.observe(threadId, input.project, session);
      return threadId;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async interrupt(threadId: string): Promise<void> {
    this.binding(threadId);
    await this.sessions.get(threadId)?.interrupt();
  }

  async release(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      this.unsubscribe.get(threadId)?.();
      this.unsubscribe.delete(threadId);
      await session.close();
      await this.deliveries.get(threadId);
      this.deliveries.delete(threadId);
      this.sessions.delete(threadId);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.release(id)));
  }

  async interruptAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.interrupt()));
  }

  private checkCapacity(): void {
    if (this.sessions.size >= 8) {
      throw new DorimakiError("session_limit", "Eight omo sessions are open. Restart dorimaki to release idle processes; history is preserved.");
    }
  }
}

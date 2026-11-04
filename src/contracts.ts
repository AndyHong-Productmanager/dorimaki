export class DorimakiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DorimakiError";
  }
}

export type Config = {
  readonly applicationId: string;
  readonly guildId: string;
  readonly allowedUserIds: readonly string[];
  readonly omoPath: string;
  readonly dataDir: string;
  readonly token: string;
};

export type Project = {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly directory: string;
};

export type Conversation = {
  readonly threadId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly active: boolean;
};

export type Attachment = {
  readonly url: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string | null;
};

export type LocalAttachment = {
  readonly path: string;
  readonly name: string;
  readonly contentType: string;
};

export type CatalogEntry = {
  readonly kind: "agent" | "command" | "skill";
  readonly name: string;
  readonly description: string;
  readonly invocation: string;
};

export type EngineEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "activity"; readonly text: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "end" }
  | { readonly kind: "catalog-changed" };

export type EngineIdentity = {
  readonly sessionId: string;
  readonly sessionFile: string;
};

export type OpenSession = {
  readonly directory: string;
  readonly mode:
    | { readonly kind: "create" }
    | { readonly kind: "resume"; readonly sessionFile: string }
    | { readonly kind: "fork"; readonly sessionFile: string };
};

export interface EngineSession {
  readonly identity: EngineIdentity;
  onBackgroundEvent(listener: (event: EngineEvent) => void): () => void;
  prompt(input: {
    readonly text: string;
    readonly attachments: readonly LocalAttachment[];
    readonly onEvent: (event: EngineEvent) => void;
  }): Promise<void>;
  interrupt(): Promise<void>;
  catalog(): Promise<readonly CatalogEntry[]>;
  close(): Promise<void>;
}

export interface Engine {
  open(input: OpenSession): Promise<EngineSession>;
  exportHtml(sessionFile: string, outputPath: string): Promise<void>;
  version(): Promise<string>;
}

export interface Store {
  addProject(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly directory: string;
  }): Promise<Project>;
  projects(): readonly Project[];
  project(channelId: string): Project | undefined;
  bind(conversation: Conversation): void;
  conversation(threadId: string): Conversation | undefined;
  conversations(projectId: string): readonly Conversation[];
  retire(threadId: string): void;
  claimMessage(messageId: string): boolean;
  finishMessage(messageId: string, outcome: "completed" | "failed" | "uncertain"): void;
  close(): void;
}

export type MessageInput = {
  readonly messageId: string;
  readonly userId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly parentChannelId: string | null;
  readonly text: string;
  readonly attachments: readonly Attachment[];
};

export type CommandInput = {
  readonly name: string;
  readonly userId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly parentChannelId: string | null;
  readonly options: Readonly<Record<string, string>>;
  readonly reply: (text: string) => Promise<void>;
};

export interface DiscordPort {
  createThread(input: {
    readonly channelId: string;
    readonly name: string;
    readonly messageId?: string;
  }): Promise<string>;
  send(threadId: string, text: string): Promise<void>;
  upload(threadId: string, paths: readonly string[]): Promise<void>;
  registerCatalog(entries: readonly CatalogEntry[]): Promise<void>;
  close(): Promise<void>;
}

export type BotHandlers = {
  readonly message: (input: MessageInput) => Promise<void>;
  readonly command: (input: CommandInput) => Promise<void>;
  readonly autocomplete: (input: {
    readonly channelId: string;
    readonly parentChannelId: string | null;
    readonly kind: CatalogEntry["kind"];
    readonly query: string;
  }) => Promise<readonly CatalogEntry[]>;
};

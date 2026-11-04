import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/app.js";
import type { DiscordPort, Engine, EngineEvent, EngineSession, MessageInput } from "../src/contracts.js";
import { openStore } from "../src/storage/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dorimaki-app-"));
  await mkdir(join(root, "project"));
  const store = openStore(join(root, "state"));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const project = await store.addProject({ guildId: "guild", channelId: "channel", directory: join(root, "project") });
  const messages: { thread: string; text: string }[] = [];
  const posted = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
  const observers = new Map<string, Set<(event: EngineEvent) => void>>();
  let threads = 0;
  const discord: DiscordPort = {
    async createThread() { threads++; return `thread-${threads}`; },
    async send(thread, text) {
      messages.push({ thread, text });
      posted.get(thread)?.resolve(text);
      posted.delete(thread);
    },
    async upload() { throw new Error("No upload expected in this scenario"); },
    async registerCatalog() {},
    async close() {},
  };
  const history = new Map<string, string[]>();
  const active = new Set<string>();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let nextId = 0;
  const engine: Engine = {
    async open(input) {
      let id: string;
      switch (input.mode.kind) {
        case "create": id = `session-${++nextId}`; history.set(id, []); break;
        case "resume": id = input.mode.sessionFile.split(/[\\/]/).at(-1) ?? ""; break;
        case "fork": {
          const source = input.mode.sessionFile.split(/[\\/]/).at(-1) ?? "";
          id = `session-${++nextId}`;
          history.set(id, [...(history.get(source) ?? [])]);
          break;
        }
      }
      if (active.has(id)) throw new Error("Session already has a writer");
      active.add(id);
      const session: EngineSession = {
        identity: { sessionId: id, sessionFile: join(root, id) },
        onBackgroundEvent(listener) {
          const listeners = observers.get(id) ?? new Set();
          listeners.add(listener);
          observers.set(id, listeners);
          return () => { listeners.delete(listener); };
        },
        async prompt(prompt) {
          if (prompt.text === "hold") { started.resolve(); await release.promise; }
          const transcript = history.get(id);
          if (!transcript) throw new Error("Missing fixture session");
          transcript.push(prompt.text);
          prompt.onEvent({ kind: "text", text: transcript.join(" / ") });
          prompt.onEvent({ kind: "end" });
        },
        async interrupt() { release.resolve(); },
        async catalog() { return []; },
        async close() { active.delete(id); },
      };
      return session;
    },
    async exportHtml() { throw new Error("No export expected in this scenario"); },
    async version() { return "test fixture"; },
  };
  const app = new Application({
    config: { applicationId: "app", guildId: "guild", allowedUserIds: ["owner"], token: "secret", omoPath: "fixture", dataDir: join(root, "state") },
    engine, discord, store,
  });
  const input = (id: string, text: string, thread?: string): MessageInput => ({
    messageId: id, text, userId: "owner", guildId: "guild",
    channelId: thread ?? "channel", parentChannelId: thread ? "channel" : null, attachments: [],
  });
  return {
    app, store, project, messages, started, release, input,
    nextDelivery(thread: string) {
      const signal = Promise.withResolvers<string>();
      posted.set(thread, signal);
      return signal.promise;
    },
    background(sessionId: string, text: string) {
      for (const listener of observers.get(sessionId) ?? []) {
        listener({ kind: "text", text });
        listener({ kind: "end" });
      }
    },
  };
}

test("channel messages create isolated persistent conversations and duplicates do not replay", async () => {
  const f = await fixture();
  await f.app.message(f.input("one", "alpha"));
  await f.app.message(f.input("two", "beta"));
  await f.app.message(f.input("three", "next", "thread-1"));
  await f.app.message(f.input("three", "next", "thread-1"));
  expect(f.messages).toEqual([
    { thread: "thread-1", text: "alpha" },
    { thread: "thread-2", text: "beta" },
    { thread: "thread-1", text: "alpha / next" },
  ]);
  expect(f.store.conversations(f.project.id).map((item) => item.sessionId)).toEqual(["session-1", "session-2"]);
  await f.app.close();
});

test("unauthorized users cannot create a thread or run an engine turn", async () => {
  const f = await fixture();
  await expect(f.app.message({ ...f.input("intruder", "run code"), userId: "stranger" }))
    .rejects.toMatchObject({ code: "unauthorized" });
  expect(f.store.conversations(f.project.id)).toEqual([]);
  expect(f.messages).toEqual([]);
  await f.app.close();
});

test("late background results reach their originating thread after the prompt returns", async () => {
  const f = await fixture();
  await f.app.message(f.input("one", "delegate"));
  await f.app.message(f.input("two", "unrelated"));
  const delivered = f.nextDelivery("thread-1");
  f.background("session-1", "Completed child result");
  expect(await delivered).toBe("Completed child result");
  expect(f.messages.at(-1)).toEqual({ thread: "thread-1", text: "Completed child result" });
  await f.app.close();
});

test("resume waits for a source turn and retires its former thread binding", async () => {
  const f = await fixture();
  const first = f.app.message(f.input("one", "hold"));
  await f.started.promise;
  const resumed = f.app.command({
    name: "resume", userId: "owner", guildId: "guild",
    channelId: "channel", parentChannelId: null,
    options: { session: "session-1" }, reply: async () => {},
  });
  f.release.resolve();
  await Promise.all([first, resumed]);
  expect(f.store.conversation("thread-1")?.active).toBe(false);
  expect(f.store.conversation("thread-2")?.sessionId).toBe("session-1");
  await f.app.message(f.input("two", "continued", "thread-2"));
  expect(f.messages.at(-1)).toEqual({ thread: "thread-2", text: "hold / continued" });
  await f.app.close();
});

test("a second resume releases the current writer rather than a historical thread", async () => {
  const f = await fixture();
  await f.app.message(f.input("one", "original"));
  const resume = () => f.app.command({
    name: "resume", userId: "owner", guildId: "guild",
    channelId: "channel", parentChannelId: null,
    options: { session: "session-1" }, reply: async () => {},
  });
  await resume();
  await resume();
  expect(f.store.conversation("thread-2")?.active).toBe(false);
  expect(f.store.conversation("thread-3")?.active).toBe(true);
  await f.app.message(f.input("two", "after two resumes", "thread-3"));
  expect(f.messages.at(-1)?.text).toBe("original / after two resumes");
  await f.app.close();
});

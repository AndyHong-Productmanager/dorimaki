import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Conversation, type Project, type Store } from "../../src/contracts";
import { openStore } from "../../src/storage";

describe("SQLite storage", () => {
  let root: string;
  let directory: string;
  let dataDir: string;
  let store: Store;
  const extraStores: Store[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dorimaki-storage-"));
    directory = join(root, "project");
    dataDir = join(root, "data");
    mkdirSync(directory);
    store = openStore(dataDir);
  });
  afterEach(() => {
    store.close();
    for (const extra of extraStores.splice(0)) extra.close();
    rmSync(root, { recursive: true, force: true });
  });

  const add = () => store.addProject({ guildId: "guild", channelId: "channel", directory });
  const binding = (project: Project, override: Partial<Conversation> = {}): Conversation => ({
    threadId: "thread",
    projectId: project.id,
    sessionId: "session",
    sessionFile: join(root, "session.jsonl"),
    active: true,
    ...override,
  });

  test("canonical directory and project identity persist across reopen", async () => {
    const project = await store.addProject({
      guildId: "guild", channelId: "channel", directory: join(directory, "..", "project"),
    });
    expect(project.directory).toBe(realpathSync(directory));
    expect(store.project("missing")).toBeUndefined();
    expect(store.project("channel")).toEqual(project);
    store.close();
    store = openStore(dataDir);
    expect(store.projects()).toEqual([project]);
    expect(store.project("channel")).toEqual(project);
  });

  test("directory, alias, guild and channel collisions never overwrite mappings", async () => {
    const project = await add();
    const alias = join(root, "alias");
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const other = join(root, "other");
    mkdirSync(other);
    for (const input of [
      { guildId: "guild", channelId: "other", directory },
      { guildId: "other-guild", channelId: "other", directory: alias },
      { guildId: "other-guild", channelId: "channel", directory: other },
      { guildId: "guild", channelId: "channel", directory },
    ]) {
      await expect(store.addProject(input)).rejects.toMatchObject({ code: "conflict" });
    }
    expect(store.projects()).toEqual([project]);
  });

  test("racing registrations serialize at the unique constraint", async () => {
    const second = openStore(dataDir);
    extraStores.push(second);
    const results = await Promise.allSettled([
      add(),
      second.addProject({ guildId: "guild", channelId: "second", directory }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.projects()).toHaveLength(1);
  });

  test("rejects missing directories, files and malformed project records", async () => {
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    for (const path of [file, join(root, "missing")]) {
      await expect(store.addProject({ guildId: "guild", channelId: "channel", directory: path }))
        .rejects.toMatchObject({ code: "invalid_directory" });
    }
    await expect(store.addProject({ guildId: "", channelId: "channel", directory }))
      .rejects.toMatchObject({ code: "invalid_record" });
    expect(store.projects()).toEqual([]);
  });

  test("active binding migration retires the prior thread atomically and survives restart", async () => {
    const project = await add();
    const initial = binding(project);
    const migrated = binding(project, { threadId: "resumed" });
    store.bind(initial);
    store.bind(migrated);
    expect(store.conversation("thread")).toEqual({ ...initial, active: false });
    expect(store.conversation("resumed")).toEqual(migrated);
    store.bind(migrated);
    expect(store.conversations(project.id)).toHaveLength(2);
    store.close();
    store = openStore(dataDir);
    expect(store.conversations(project.id)).toEqual([{ ...initial, active: false }, migrated]);
    store.retire("resumed");
    store.retire("missing");
    expect(store.conversation("resumed")?.active).toBe(false);
    expect(store.conversation("missing")).toBeUndefined();
  });

  test("a distinct fork stays active and an inactive binding does not retire its source", async () => {
    const project = await add();
    store.bind(binding(project));
    store.bind(binding(project, { threadId: "fork", sessionId: "forked", sessionFile: join(root, "fork.jsonl") }));
    store.bind(binding(project, { threadId: "historical", active: false }));
    expect(store.conversations(project.id).filter((item) => item.active).map((item) => item.threadId))
      .toEqual(["thread", "fork"]);
  });

  test("failed binding validation and thread rebinding leave the active binding unchanged", async () => {
    const project = await add();
    const initial = binding(project);
    store.bind(initial);
    for (const bad of [
      binding(project, { threadId: "new", projectId: "missing" }),
      binding(project, { sessionId: "different" }),
      binding(project, { sessionFile: join(root, "different.jsonl") }),
      binding(project, { threadId: "", active: true }),
      binding(project, { threadId: "relative", sessionFile: "relative.jsonl" }),
      { ...binding(project), active: 1 } as unknown as Conversation,
    ]) {
      expect(() => store.bind(bad)).toThrow();
    }
    expect(store.conversations(project.id)).toEqual([initial]);
  });

  test("duplicate claims remain rejected for every outcome and unfinished ingress after restart", () => {
    const second = openStore(dataDir);
    extraStores.push(second);
    for (const outcome of ["completed", "failed", "uncertain"] as const) {
      expect(store.claimMessage(outcome)).toBe(true);
      expect(second.claimMessage(outcome)).toBe(false);
      store.finishMessage(outcome, outcome);
      store.finishMessage(outcome, outcome);
      expect(store.claimMessage(outcome)).toBe(false);
    }
    expect(store.claimMessage("unfinished")).toBe(true);
    store.close();
    store = openStore(dataDir);
    for (const id of ["completed", "failed", "uncertain", "unfinished"]) {
      expect(store.claimMessage(id)).toBe(false);
    }
  });

  test("uncertain outcomes cannot be erased or converted into automatic retries", () => {
    expect(() => store.finishMessage("unclaimed", "completed"))
      .toThrow("Message must be claimed");
    expect(store.claimMessage("message")).toBe(true);
    store.finishMessage("message", "uncertain");
    expect(() => store.finishMessage("message", "completed")).toThrow("cannot be overwritten");
    expect(() => store.finishMessage("message", "failed")).toThrow("cannot be overwritten");
    expect(() => store.finishMessage("message", "wrong" as "completed")).toThrow("Invalid ingress outcome");
    expect(() => store.claimMessage("\u0000")).toThrow("without control characters");
    store.close();
    const db = new Database(join(dataDir, "dorimaki.sqlite"));
    try {
      expect(db.query("SELECT state FROM ingress WHERE messageId = ?").get("message"))
        .toEqual({ state: "uncertain" });
    } finally {
      db.close();
    }
  });

  test("validates database reads and closes idempotently without leaking a file handle", async () => {
    await add();
    const db = new Database(join(dataDir, "dorimaki.sqlite"));
    try {
      db.query("UPDATE projects SET guildId = ?").run("bad\u0000record");
    } finally {
      db.close();
    }
    expect(() => store.projects()).toThrow("without control characters");
    store.close();
    store.close();
    expect(() => store.projects()).toThrow("closed");
    expect(() => store.claimMessage("closed")).toThrow("closed");
    await expect(add()).rejects.toMatchObject({ code: "store_closed" });
  });
});

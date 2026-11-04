import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEngine } from "../../src/engine";
import { RpcProcess, childEnvironment } from "../../src/engine/rpc";
import type { Config, EngineEvent, EngineSession } from "../../src/contracts";

const resources: { close(): Promise<void> }[] = [];
const roots: string[] = [];
const fixture = resolve(import.meta.dir, "fixture.ts");
const fixtureRoot = await mkdtemp(join(tmpdir(), "dorimaki-engine-fixture-"));
const fixtureExecutable = join(fixtureRoot, process.platform === "win32" ? "omo.exe" : "omo");
beforeAll(async () => {
  const build = Bun.spawn([process.execPath, "build", fixture, "--compile", "--outfile", fixtureExecutable], { stdout: "pipe", stderr: "pipe" });
  const errors = new Response(build.stderr).text();
  const code = await build.exited;
  if (code !== 0) throw new Error(`Fixture compilation failed: ${await errors}`);
}, 30_000);
afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "dorimaki-engine-test-"));
  roots.push(root);
  return root;
}

// Exercise the real public Engine boundary with an actual executable child.
async function openFixture(env: Record<string, string> = {}): Promise<EngineSession> {
  const root = await sandbox();
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const config: Config = { applicationId: "a", guildId: "g", allowedUserIds: [], token: "unused", dataDir: join(root, "data"), omoPath: fixtureExecutable };
    const session = await createEngine(config).open({ directory: root, mode: { kind: "create" } });
    resources.push(session);
    return session;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("decodes split UTF-8 NDJSON and does not repeat final assistant text", async () => {
  const session = await openFixture();
  const events: EngineEvent[] = [];
  await session.prompt({ text: "stream", attachments: [], onEvent: (event) => events.push(event) });
  expect(events.filter((event) => event.kind === "text").map((event) => event.text).join("")).toBe("Hello 한글");
  expect(events.at(-1)).toEqual({ kind: "end" });
});

test("delivers background completion after the initiating prompt has ended", async () => {
  const session = await openFixture();
  const completed = Promise.withResolvers<void>();
  let output = "";
  const unsubscribe = session.onBackgroundEvent((event) => {
    if (event.kind === "text") output += event.text;
    if (event.kind === "end") completed.resolve();
  });
  await session.prompt({ text: "delegate", attachments: [], onEvent() {} });
  await session.catalog();
  await completed.promise;
  expect(output).toBe("Completed delegated work");
  unsubscribe();
});

test("queues foreground input behind a running background continuation", async () => {
  const session = await openFixture({ FIXTURE_BACKGROUND_WAIT: "1" });
  const running = Promise.withResolvers<void>();
  const unsubscribe = session.onBackgroundEvent((event) => {
    if (event.kind === "activity") running.resolve();
  });
  await session.prompt({ text: "delegate", attachments: [], onEvent() {} });
  await session.catalog();
  await running.promise;
  let output = "";
  const next = session.prompt({ text: "stream", attachments: [], onEvent(event) {
    if (event.kind === "text") output += event.text;
  } });
  await session.interrupt();
  await next;
  expect(output).toBe("Hello 한글");
  unsubscribe();
});

test("waits beyond prompt acceptance and tool-loop end until actual idle", async () => {
  const session = await openFixture({ FIXTURE_EARLY_END: "1" });
  const ready = Promise.withResolvers<void>();
  let settled = false;
  const completion = session.prompt({
    text: "early-ack", attachments: [],
    onEvent(event) { if (event.kind === "activity") ready.resolve(); },
  }).then(() => { settled = true; });
  await ready.promise;
  // A separate child round trip lets the acceptance promise propagate fully,
  // while the fixture deliberately keeps this turn open.
  await session.catalog();
  expect(settled).toBe(false);
  await session.interrupt();
  await completion;
  expect(settled).toBe(true);
});

test("correlates out-of-order discovery responses and preserves native invocation markers", async () => {
  const session = await openFixture();
  const entries = await session.catalog();
  expect(entries.map(({ kind, name }) => ({ kind, name }))).toEqual([
    { kind: "agent", name: "explore" },
    { kind: "agent", name: "librarian" },
    { kind: "command", name: "inspect" },
    { kind: "skill", name: "paint" },
  ]);
  expect(entries.filter((entry) => entry.kind !== "agent").map((entry) => entry.invocation)).toEqual(["/inspect", "$skill:paint"]);
  expect(entries.filter((entry) => entry.kind === "agent").map((entry) => /subagent_type=("[^"]+")/.exec(entry.invocation)?.[1]).map((name) => name && JSON.parse(name))).toEqual(["explore", "librarian"]);
});

test.each([
  ["reject", "provider_credentials_missing"],
  ["eof", "engine_eof"],
  ["partial", "engine_eof"],
  ["malformed", "engine_protocol"],
  ["mismatch", "engine_protocol"],
  ["fail", "engine_turn_failed"],
])("rejects %s rather than accepting failed or lost turns", async (text, code) => {
  const session = await openFixture();
  const error = await session.prompt({ text, attachments: [], onEvent() {} }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toMatchObject({ code });
});

test("interrupt rejects the active turn and permits a later prompt", async () => {
  const session = await openFixture();
  const ready = Promise.withResolvers<void>();
  const pending = session.prompt({ text: "wait", attachments: [], onEvent(event) { if (event.kind === "activity") ready.resolve(); } });
  const rejection = pending.then(() => undefined, (cause: unknown) => cause);
  await ready.promise;
  await session.interrupt();
  expect(await rejection).toMatchObject({ code: "engine_interrupted" });
  await session.prompt({ text: "stream", attachments: [], onEvent() {} });
});

test("does not settle on a retry's interim agent end", async () => {
  const session = await openFixture();
  let output = "";
  await session.prompt({ text: "retry", attachments: [], onEvent(event) { if (event.kind === "text") output += event.text; } });
  expect(output).toBe("Hello 한글Retry completed");
});

test("interrupt during local attachment staging cancels the input before submission", async () => {
  const session = await openFixture();
  const root = await sandbox();
  const file = join(root, "pending.txt");
  await writeFile(file, "Attachment staged before native submission");
  const pending = session.prompt({
    text: "wait",
    attachments: [{ path: file, name: "pending.txt", contentType: "text/plain" }],
    onEvent() {},
  }).then(() => undefined, (cause: unknown) => cause);
  // prompt is synchronously reserved but must await filesystem work before RPC.
  await session.interrupt();
  expect(await pending).toMatchObject({ code: "engine_interrupted" });
});

test("create, exact resume, fork, version, and export use the owned executable", async () => {
  const root = await sandbox();
  const config: Config = { applicationId: "a", guildId: "g", allowedUserIds: [], token: "unused", dataDir: join(root, "data"), omoPath: fixtureExecutable };
  const engine = createEngine(config);
  const created = await engine.open({ directory: root, mode: { kind: "create" } });
  resources.push(created);
  const identity = created.identity;
  await created.close();
  const resumed = await engine.open({ directory: root, mode: { kind: "resume", sessionFile: identity.sessionFile } });
  resources.push(resumed);
  expect(resumed.identity).toEqual(identity);
  await resumed.close();
  const forked = await engine.open({ directory: root, mode: { kind: "fork", sessionFile: identity.sessionFile } });
  resources.push(forked);
  expect(forked.identity.sessionId).not.toBe(identity.sessionId);
  await forked.close();
  expect(await engine.version()).toBe("omo fixture 1");
  const html = join(root, "export.html");
  await engine.exportHtml(identity.sessionFile, html);
  expect(await readFile(html, "utf8")).toContain("created");
});

test("close rejects outstanding work instead of emitting a successful completion", async () => {
  const session = await openFixture();
  const ready = Promise.withResolvers<void>();
  const pending = session.prompt({ text: "wait", attachments: [], onEvent(event) { if (event.kind === "activity") ready.resolve(); } });
  const rejection = pending.then(() => undefined, (cause: unknown) => cause);
  await ready.promise;
  await session.close();
  expect(await rejection).toMatchObject({ code: "engine_closed" });
});

test("encodes images and supplies lossless local file metadata on ongoing turns", async () => {
  const session = await openFixture();
  const root = await sandbox();
  const image = join(root, "image.png");
  const document = join(root, "note.bin");
  await writeFile(image, Buffer.from([137, 80, 78, 71]));
  await writeFile(document, Buffer.from([0, 1, 2, 255]));
  let output = "";
  await session.prompt({
    text: "attachments",
    attachments: [
      { path: image, name: "image.png", contentType: "image/png" },
      { path: document, name: "note.bin", contentType: "application/octet-stream" },
    ],
    onEvent(event) { if (event.kind === "text") output += event.text; },
  });
  const payload = JSON.parse(output);
  expect(payload.images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
  expect(payload.message).toContain(JSON.stringify({ path: document, name: "note.bin", contentType: "application/octet-stream" }));
  expect(await readFile(document)).toEqual(Buffer.from([0, 1, 2, 255]));
});

test("rejects interactive approvals instead of automatically granting them", async () => {
  const session = await openFixture();
  const error = await session.prompt({ text: "approval", attachments: [], onEvent() {} }).then(() => undefined, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "engine_approval_required" });
});

test("sanitizes inherited routing while preserving configured credential access", async () => {
  const root = await sandbox();
  const overrides = { OMO_RPC_SOCKET_PATH: "parent", PI_SESSION_ID: "parent-session", SENPI_CODING_AGENT_DIR: "account-root", DORIMAKI_FIXTURE_PROVIDER_KEY: "fixture-only", DISCORD_BOT_TOKEN: "fixture-discord-token" };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const env = childEnvironment();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const rpc = new RpcProcess([process.execPath, fixture], root, env);
  resources.push(rpc);
  expect(await rpc.request("inspect_env")).toMatchObject({ parentSocket: null, parentSession: null, accountDirectory: "account-root", providerKey: "fixture-only", discordTokenPresent: false });
});

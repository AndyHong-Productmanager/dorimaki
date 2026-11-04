import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutocompleteInteraction, ChatInputCommandInteraction, Client, ClientApplication,
  Events, Guild, Message, TextChannel, type ClientEvents,
} from "discord.js";
import type { BotHandlers, CatalogEntry, CommandInput, Config, MessageInput } from "../../src/contracts";
import { connectClient } from "../../src/discord/transport";
import { connectDiscord } from "../../src/discord";

const ids = { app: "100000000000000001", guild: "100000000000000002", channel: "100000000000000003", user: "100000000000000004", message: "100000000000000005" };
const config: Config = {
  applicationId: ids.app, guildId: ids.guild, allowedUserIds: [ids.user],
  token: "test-secret-token", omoPath: "", dataDir: "",
};
const actor = { id: ids.user, username: "operator", discriminator: "0", avatar: null, bot: false };
const entry = (name: string, kind: CatalogEntry["kind"] = "command"): CatalogEntry =>
  ({ name, kind, description: `Run ${name}`, invocation: `/${name}` });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const noopHandlers: BotHandlers = { message: async () => {}, command: async () => {}, autocomplete: async () => [] };

async function harness(overrides: Partial<BotHandlers> = {}) {
  const client = new Client({ intents: [] });
  // discord.js exports runtime constructors but marks them internal in its .d.ts.
  client.application = Reflect.construct(ClientApplication, [client, { id: ids.app }]) as ClientApplication;
  const guild = Reflect.construct(Guild, [client, { id: ids.guild, name: "test" }]) as Guild;
  client.guilds.cache.set(guild.id, guild);
  const channel = Reflect.construct(TextChannel, [guild, { id: ids.channel, type: 0, name: "project" }, client]) as TextChannel;
  client.channels.cache.set(channel.id, channel);
  const puts: unknown[] = [];
  const posts: { route: string; options: unknown }[] = [];
  const patches: unknown[] = [];
  const response = signal<unknown>();
  const login = spyOn(client, "login").mockImplementation(async () => { client.emit(Events.ClientReady, client as Client<true>); return config.token; });
  const destroy = spyOn(client, "destroy").mockResolvedValue(undefined);
  const put = spyOn(client.rest, "put").mockImplementation(async (_route, options) => { puts.push(options?.body); return []; });
  const get = spyOn(client.rest, "get").mockRejectedValue(new Error("Unconfigured fixture read"));
  const post = spyOn(client.rest, "post").mockImplementation(async (route, options) => {
    posts.push({ route, options });
    response.resolve(options);
    return { id: ids.message, channel_id: ids.channel, author: actor, content: "", attachments: [], embeds: [], type: 0 };
  });
  const patch = spyOn(client.rest, "patch").mockImplementation(async (_route, options) => {
    patches.push(options?.body); response.resolve(options);
    return { id: ids.message, channel_id: ids.channel, author: actor, content: "", attachments: [], embeds: [], type: 0 };
  });
  const port = await connectClient(client, config, { ...noopHandlers, ...overrides });
  cleanups.push(async () => { await port.close(); login.mockRestore(); destroy.mockRestore(); put.mockRestore(); get.mockRestore(); post.mockRestore(); patch.mockRestore(); });
  function message(extra = {}) {
    return Reflect.construct(Message, [client, {
      id: ids.message, channel_id: ids.channel, guild_id: ids.guild,
      author: actor, type: 0, content: "hello", attachments: [], embeds: [], ...extra,
    }]) as ClientEvents[Events.MessageCreate][0];
  }
  function interaction(name: string, options: unknown[] = [], extra = {}, autocomplete = false) {
    const data = {
      id: ids.message, application_id: ids.app, guild_id: ids.guild,
      channel: { id: ids.channel, type: 0 }, user: actor, token: "interaction-token",
      type: autocomplete ? 4 : 2, data: { id: ids.message, name, type: 1, options },
      entitlements: [], authorizing_integration_owners: {}, locale: "en-US", ...extra,
    };
    return autocomplete
      ? Reflect.construct(AutocompleteInteraction, [client, data]) as AutocompleteInteraction
      : Reflect.construct(ChatInputCommandInteraction, [client, data]) as ChatInputCommandInteraction;
  }
  return { client, channel, port, puts, posts, patches, response, message, interaction, put, post, patch, destroy };
}

test("exports the required entry point; installs typed fixed commands after readiness", async () => {
  expect(typeof connectDiscord).toBe("function");
  const h = await harness();
  expect(h.puts).toHaveLength(1);
  const commands = h.puts[0] as { name: string; options: { name: string; type: number; required: boolean; autocomplete?: boolean }[] }[];
  expect(commands.map(c => c.name)).toEqual(["new", "resume", "fork", "stop", "share", "session-id", "status", "agent", "command", "skill"]);
  expect(commands.find(c => c.name === "share")?.options[0]).toMatchObject({ name: "confirm", type: 5, required: true });
  expect(commands.find(c => c.name === "resume")?.options[0]).toMatchObject({ name: "session", type: 3, required: true });
  expect(commands.find(c => c.name === "agent")?.options[0]).toMatchObject({ name: "name", autocomplete: true });
  expect(commands.find(c => c.name === "new")?.options).toEqual([
    expect.objectContaining({ name: "name", type: 3, required: false }),
  ]);
});

test.each([
  ["new", [{ name: "name", type: 3, value: "My conversation" }], { name: "My conversation" }],
  ["resume", [{ name: "session", type: 3, value: "stored-session-id" }], { session: "stored-session-id" }],
  ["share", [{ name: "confirm", type: 5, value: false }], { confirm: "false" }],
] as const)("passes integration options for /%s unchanged", async (name, options, expected) => {
  const done = signal<CommandInput>();
  const h = await harness({ command: async input => { await input.reply("ok"); done.resolve(input); } });
  h.client.emit(Events.InteractionCreate, h.interaction(name, [...options]));
  expect(await done.promise).toMatchObject({ name, options: expected });
});

test.each(["agent", "command", "skill"] as const)("maps generic and shortcut %s invocations identically", async kind => {
  let done = signal<CommandInput>();
  const h = await harness({ command: async input => { await input.reply("ok"); done.resolve(input); } });
  await h.port.registerCatalog([entry("Original Name", kind)]);
  const argumentsOption = { name: "prompt", type: 3, value: "user arguments" };
  h.client.emit(Events.InteractionCreate, h.interaction(kind, [
    { name: "name", type: 3, value: "Original Name" }, argumentsOption,
  ]));
  expect(await done.promise).toMatchObject({ name: kind, options: { name: "Original Name", prompt: "user arguments" } });
  done = signal<CommandInput>();
  const suffix = kind === "command" ? "cmd" : kind;
  h.client.emit(Events.InteractionCreate, h.interaction(`original-name-${suffix}`, [argumentsOption]));
  expect(await done.promise).toMatchObject({ name: kind, options: { name: "Original Name", prompt: "user arguments" } });
});

test("public entry point cleans up failed login without leaking credentials", async () => {
  const login = spyOn(Client.prototype, "login").mockRejectedValue(new Error(`Invalid ${config.token}`));
  const destroy = spyOn(Client.prototype, "destroy").mockResolvedValue(undefined);
  try {
    await expect(connectDiscord(config, noopHandlers)).rejects.toThrow("Invalid [REDACTED]");
    expect(destroy).toHaveBeenCalledTimes(1);
  } finally { login.mockRestore(); destroy.mockRestore(); }
});

test("filters bot, webhook, DM, wrong-guild and unlisted users before frozen message dispatch", async () => {
  const received: MessageInput[] = [];
  const done = signal<void>();
  const h = await harness({ message: async input => { received.push(input); done.resolve(); } });
  for (const extra of [
    { author: { ...actor, bot: true } }, { webhook_id: ids.app },
    { guild_id: null, channel_id: "100000000000000099" },
    { guild_id: "100000000000000099" }, { author: { ...actor, id: "100000000000000088" } },
  ]) h.client.emit(Events.MessageCreate, h.message(extra));
  h.client.emit(Events.MessageCreate, h.message({ attachments: [{ id: ids.message, filename: "a.txt", size: 3, url: "https://cdn.discordapp.com/a", proxy_url: "", content_type: "text/plain" }] }));
  await done.promise;
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ userId: ids.user, guildId: ids.guild, parentChannelId: null, text: "hello" });
  expect(Object.isFrozen(received[0])).toBe(true);
  expect(Object.isFrozen(received[0]!.attachments)).toBe(true);
  expect(Object.isFrozen(received[0]!.attachments[0])).toBe(true);
});

test("normalizes boolean confirmation and defers ephemerally before command handler", async () => {
  const done = signal<void>();
  let input: CommandInput | undefined;
  const h = await harness({ command: async command => { input = command; await command.reply("ok"); done.resolve(); } });
  h.client.emit(Events.InteractionCreate, h.interaction("share", [{ name: "confirm", type: 5, value: true }]));
  await done.promise;
  expect(input?.options).toEqual({ confirm: "true" });
  expect(h.posts[0]?.options).toMatchObject({ body: { type: 5, data: { flags: 64 } } });
  expect(h.patches[0]).toMatchObject({ content: "ok", allowed_mentions: { parse: [], replied_user: false } });
});

test("denies unauthorized slash commands without invoking handlers", async () => {
  let calls = 0;
  const h = await harness({ command: async () => { calls++; } });
  h.client.emit(Events.InteractionCreate, h.interaction("status", [], { user: { ...actor, bot: true } }));
  h.client.emit(Events.InteractionCreate, h.interaction("status", [], { guild_id: null }));
  h.client.emit(Events.InteractionCreate, h.interaction("status", [], { guild_id: "100000000000000099" }));
  await h.response.promise;
  expect(calls).toBe(0);
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]?.options).toMatchObject({ body: { type: 4, data: { flags: 64 } } });
});

test("creates real thread REST requests both independently and from a triggering message", async () => {
  const h = await harness();
  const routes: string[] = [];
  h.post.mockImplementation(async (route) => {
    routes.push(route);
    return {
      id: "100000000000000077", guild_id: ids.guild, parent_id: ids.channel,
      type: 11, name: "conversation", owner_id: ids.user,
      thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: "2026-11-04T00:00:00Z", locked: false },
    };
  });
  expect(await h.port.createThread({ channelId: ids.channel, name: "conversation" })).toBe("100000000000000077");
  h.channel.messages.cache.set(ids.message, h.message() as Message<true>);
  expect(await h.port.createThread({ channelId: ids.channel, name: "conversation", messageId: ids.message })).toBe("100000000000000077");
  expect(routes).toEqual([`/channels/${ids.channel}/threads`, `/channels/${ids.channel}/messages/${ids.message}/threads`]);
});

test("unauthorized autocomplete discloses no catalog; authorized results cap at 25", async () => {
  let calls = 0;
  const h = await harness({ autocomplete: async () => { calls++; return Array.from({ length: 30 }, (_, i) => entry(`item-${i}`)); } });
  const denied = h.interaction("command", [{ name: "name", type: 3, value: "", focused: true }], { user: { ...actor, id: "100000000000000099" } }, true);
  h.client.emit(Events.InteractionCreate, denied);
  await h.response.promise;
  expect(calls).toBe(0);
  expect(h.posts[0]?.options).toMatchObject({ body: { type: 8, data: { choices: [] } } });
  const answered = signal<void>();
  h.post.mockImplementation(async (_route, options) => {
    const body = options?.body as { data: { choices: unknown[] } };
    expect(body.data.choices).toHaveLength(25); answered.resolve(); return {};
  });
  h.client.emit(Events.InteractionCreate, h.interaction("command", [{ name: "name", type: 3, value: "", focused: true }], {}, true));
  await answered.promise;
  expect(calls).toBe(1);
});

test("deterministic shortcut mapping serializes updates and retains generic access beyond shortcut limits", async () => {
  const done = signal<CommandInput>();
  const h = await harness({ command: async input => { await input.reply("ok"); done.resolve(input); } });
  const started = signal<void>(), release = signal<void>();
  let active = 0, peak = 0;
  h.put.mockImplementation(async () => {
    active++; peak = Math.max(peak, active); started.resolve();
    await release.promise; active--; return [];
  });
  const first = h.port.registerCatalog([entry("Zed"), entry("Code Review", "agent")]);
  await started.promise;
  const second = h.port.registerCatalog([entry("Zed")]);
  release.resolve();
  await Promise.all([first, second]);
  expect(peak).toBe(1);
  h.client.emit(Events.InteractionCreate, h.interaction("zed-cmd", [{ name: "prompt", type: 3, value: "do it" }]));
  expect(await done.promise).toMatchObject({ name: "command", options: { name: "Zed", prompt: "do it" } });
  const writes: unknown[] = [];
  h.put.mockImplementation(async (_route, options) => { writes.push(options?.body); return []; });
  await h.port.registerCatalog([entry("a b"), entry("a-b")]);
  expect(writes[0]).toHaveLength(11);
  await h.port.registerCatalog(Array.from({ length: 91 }, (_, i) => entry(`n${i}`)));
  expect(writes[1]).toHaveLength(100);
  await h.port.registerCatalog([]);
});

test("reinstalls the desired catalog after gateway resume", async () => {
  const h = await harness();
  await h.port.registerCatalog([entry("restored")]);
  const registered = signal<unknown>();
  h.put.mockImplementation(async (_route, options) => { registered.resolve(options?.body); return []; });
  h.client.emit(Events.ShardResume, 0, 1);
  expect(await registered.promise).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "restored-cmd" }),
  ]));
});

test("real MessagePayload chunks Unicode safely, disables mentions and uploads file bytes", async () => {
  const h = await harness();
  const text = "a".repeat(1999) + "😀" + "@everyone\n" + "b".repeat(2100);
  await h.port.send(ids.channel, text);
  const bodies = h.posts.map(p => (p.options as { body: { content: string; allowed_mentions: unknown } }).body);
  expect(bodies.map(b => b.content).join("")).toBe(text);
  expect(bodies.every(b => b.content.length <= 2000 && !/[\uD800-\uDFFF]/u.test(b.content))).toBe(true);
  expect(bodies.every(b => JSON.stringify(b.allowed_mentions) === '{"parse":[],"replied_user":false}')).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "dorimaki-discord-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.txt");
  await writeFile(file, "actual upload bytes");
  await h.port.upload(ids.channel, [file]);
  const upload = h.posts.at(-1)?.options as { files: { data: Buffer; name: string }[] };
  expect(upload.files[0]?.data.toString()).toBe("actual upload bytes");
  expect(upload.files[0]?.name).toBe("sample.txt");
  await expect(h.port.send("100000000000000099", "x")).rejects.toThrow();
});

test("handler failures redact token; close removes listeners and destroys client", async () => {
  const h = await harness({ command: async () => { throw new Error(`failed ${config.token} api_key=private`); } });
  const done = signal<void>();
  h.patch.mockImplementation(async (_route, options) => {
    expect(JSON.stringify(options)).not.toContain(config.token);
    expect(JSON.stringify(options)).not.toContain("private");
    done.resolve();
    return { id: ids.message, channel_id: ids.channel, author: actor, content: "", attachments: [], embeds: [] };
  });
  h.client.emit(Events.InteractionCreate, h.interaction("status"));
  await done.promise;
  await h.port.close();
  expect(h.destroy).toHaveBeenCalledTimes(1);
  expect(h.client.listenerCount(Events.MessageCreate)).toBe(0);
  await expect(h.port.send(ids.channel, "x")).rejects.toThrow("closed");
});

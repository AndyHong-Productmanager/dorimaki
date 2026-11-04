import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalogs } from "../src/catalogs";
import { openStore } from "../src/storage";
import type { CatalogEntry, Engine } from "../src/contracts";

test("startup merges project catalogs and removes only its closed discovery sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dorimaki-catalogs-"));
  const store = openStore(join(root, "state"));
  const original = join(root, "original-session.jsonl");
  const closed: string[] = [];
  const created: string[] = [];
  const registrations: (readonly CatalogEntry[])[] = [];
  try {
    await writeFile(original, "existing history");
    for (const name of ["first", "second"]) {
      const directory = join(root, name);
      await mkdir(directory);
      await store.addProject({ guildId: "guild", channelId: name, directory });
    }
    const engine: Engine = {
      async open(input) {
        const name = input.directory.split(/[\\/]/).at(-1) ?? "";
        const sessionFile = join(root, `${name}.jsonl`);
        await writeFile(sessionFile, "discovery");
        created.push(sessionFile);
        return {
          identity: { sessionId: name, sessionFile },
          onBackgroundEvent() { return () => {}; },
          async catalog() {
            return [
              { kind: "command", name: "shared", description: "", invocation: "/shared" },
              { kind: "skill", name, description: "", invocation: `$skill:${name}` },
            ];
          },
          async prompt() { throw new Error("Discovery must not generate a model turn"); },
          async interrupt() {},
          async close() { await access(sessionFile); closed.push(name); },
        };
      },
      async exportHtml() { throw new Error("Unexpected export"); },
      async version() { return "fixture"; },
    };
    const catalogs = new Catalogs({
      engine, store,
      config: { dataDir: root, guildId: "guild", applicationId: "app", allowedUserIds: [], token: "", omoPath: "" },
      discord: {
        async createThread() { throw new Error("Discovery must not create Discord threads"); },
        async send() {}, async upload() {}, async close() {},
        async registerCatalog(entries) { registrations.push(entries); },
      },
    });
    await catalogs.initialize();
    expect(registrations.at(-1)?.map((item) => `${item.kind}:${item.name}`)).toEqual([
      "command:shared", "skill:first", "skill:second",
    ]);
    expect(closed).toEqual(["first", "second"]);
    for (const path of created) expect(await Bun.file(path).exists()).toBe(false);
    expect(await readFile(original, "utf8")).toBe("existing history");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Engine } from "../../src/contracts";
import { createShare } from "../../src/share";

let directory: string;
function engine(exportHtml: Engine["exportHtml"]): Engine {
  return {
    exportHtml,
    async open() { throw new Error("Export must not open a session"); },
    async version() { throw new Error("Export must not query version"); },
  };
}

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "dorimaki-share-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("calls engine export with exact session and unique local HTML paths", async () => {
  const calls: { session: string; output: string }[] = [];
  const exporter = engine(async (session, output) => {
    calls.push({ session, output });
    await writeFile(output, "<!doctype html><p>original secret remains</p>");
  });
  const input = { engine: exporter, sessionFile: "C:/sessions/source.jsonl", dataDir: directory };
  const first = await createShare(input);
  const second = await createShare(input);
  expect(calls.map((call) => call.session)).toEqual([input.sessionFile, input.sessionFile]);
  expect(calls.map((call) => call.output)).toEqual([first, second]);
  expect(first).not.toBe(second);
  expect(first.endsWith(".html")).toBe(true);
  expect(await readFile(first, "utf8")).toContain("original secret remains");
  expect(dirname(dirname(first))).toBe(join(directory, "shares"));
  // This is also the caller's post-upload ownership protocol.
  await rm(dirname(first), { recursive: true, force: true });
  await rm(dirname(second), { recursive: true, force: true });
  expect(await readdir(join(directory, "shares"))).toEqual([]);
});

test("export errors clean partial artifacts without changing source files", async () => {
  const source = join(directory, "session.jsonl");
  await writeFile(source, "source");
  const exporter = engine(async (_session, output) => {
    await writeFile(output, "partial");
    throw new Error("export failed");
  });
  await expect(createShare({ engine: exporter, sessionFile: source, dataDir: directory })).rejects.toThrow("export failed");
  expect(await readdir(join(directory, "shares"))).toEqual([]);
  expect(await readFile(source, "utf8")).toBe("source");
});

test.each(["absent", "empty", "directory"] as const)("rejects %s export outputs and cleans up", async (kind) => {
  const exporter = engine(async (_session, output) => {
    if (kind === "empty") await writeFile(output, "");
    if (kind === "directory") await mkdir(output);
  });
  await expect(createShare({ engine: exporter, sessionFile: "session", dataDir: directory })).rejects.toThrow();
  expect(await readdir(join(directory, "shares"))).toEqual([]);
});

test("rejects a junction in place of the shares root", async () => {
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "safe");
  await symlink(outside, join(directory, "shares"), process.platform === "win32" ? "junction" : "dir");
  let called = false;
  const exporter = engine(async () => { called = true; });
  await expect(createShare({ engine: exporter, sessionFile: "session", dataDir: directory }))
    .rejects.toMatchObject({ code: "UNSAFE_STORAGE" });
  expect(called).toBe(false);
  expect(await readdir(outside)).toEqual(["keep"]);
});

test("rejects a symbolic directory output and never deletes its target", async () => {
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "safe");
  const exporter = engine(async (_session, output) => {
    await symlink(outside, output, process.platform === "win32" ? "junction" : "dir");
  });
  await expect(createShare({ engine: exporter, sessionFile: "session", dataDir: directory }))
    .rejects.toMatchObject({ code: "SHARE_EXPORT" });
  expect(await readdir(outside)).toEqual(["keep"]);
  expect(await readdir(join(directory, "shares"))).toEqual([]);
});

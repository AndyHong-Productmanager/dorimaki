import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { Attachment } from "../../src/contracts";
import { stageAttachments } from "../../src/media";

const MiB = 1024 * 1024;
const url = "https://cdn.discordapp.com/attachments/123/456/original.png?ex=abc&hm=def";
let directory: string;
const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis;
let fetchSpy: ReturnType<typeof spyOn<typeof fetchTarget, "fetch">>;

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return { url, name: "original.png", size: 3, contentType: "image/png", ...overrides };
}

function stage(files: readonly Attachment[], messageId = "../../outside") {
  return stageAttachments({ dataDir: directory, messageId, files });
}

function bytes(length: number): Response {
  let remaining = length;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
      } else {
        const size = Math.min(remaining, 64 * 1024);
        remaining -= size;
        controller.enqueue(new Uint8Array(size).fill(137));
      }
    },
  }));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dorimaki-media-test-"));
  fetchSpy = spyOn(fetchTarget, "fetch").mockImplementation(async () => new Response(new Uint8Array([137, 80, 78])));
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

test("preserves image bytes, MIME, order, and unique safe paths across duplicate messages", async () => {
  const files = [attachment({ name: "../../CON.png" }), attachment({ name: "C:\\evil\\photo.png" })];
  const first = await stage(files);
  const second = await stage(files);
  expect(first.map((file) => file.name)).toEqual(["_CON.png", "photo.png"]);
  expect(first[0]!.contentType).toBe("image/png");
  expect(await readFile(first[0]!.path)).toEqual(Buffer.from([137, 80, 78]));
  expect(dirname(first[0]!.path)).toBe(dirname(first[1]!.path));
  expect(first[0]!.path).not.toBe(second[0]!.path);
  for (const file of [...first, ...second]) {
    expect(relative(join(directory, "attachments"), file.path).startsWith("..")).toBe(false);
    expect(basename(file.path)).not.toMatch(/[<>:"|?*]/);
  }
  expect((await readdir(join(directory, "attachments"))).some((name) => name.startsWith(".staging-"))).toBe(false);
});

test("falls back to response MIME or binary without converting contents", async () => {
  fetchSpy.mockImplementation(async () => new Response("raw", { headers: { "content-type": "application/pdf" } }));
  expect((await stage([attachment({ contentType: null })]))[0]!.contentType).toBe("application/pdf");
  fetchSpy.mockImplementation(async () => new Response(new Uint8Array([0, 255])));
  const result = await stage([attachment({ contentType: null, name: ".." })]);
  expect(result[0]!.name).toBe("attachment");
  expect(result[0]!.contentType).toBe("application/octet-stream");
  expect(await readFile(result[0]!.path)).toEqual(Buffer.from([0, 255]));
});

test.each([
  "http://cdn.discordapp.com/attachments/1/2/a",
  "https://cdn.discordapp.com.evil.test/attachments/1/2/a",
  "https://media.discordapp.net.evil.test/attachments/1/2/a",
  "https://127.0.0.1/attachments/1/2/a",
  "file:///attachments/1/2/a",
  "https://user:pass@cdn.discordapp.com/attachments/1/2/a",
  "https://cdn.discordapp.com:444/attachments/1/2/a",
  "https://cdn.discordapp.com/icons/1/2/a",
  "https://cdn.discordapp.com/attachments/1/2/a#fragment",
  "https://cdn.discordapp.com/attachments/1/2/a%2fb",
  "https://cdn.discordapp.com/attachments/1/2/a%5cb",
  "https://cdn.discordapp.com/attachments/1/2/%00",
  "https://cdn.discordapp.com/attachments/1/2/%zz",
  "not a URL",
])("rejects unsafe URL %s before any request", async (unsafe) => {
  await expect(stage([attachment({ url: unsafe })])).rejects.toMatchObject({ code: "ATTACHMENT_URL" });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

test("validates every redirect and never requests an untrusted destination", async () => {
  fetchSpy.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
  await expect(stage([attachment()])).rejects.toMatchObject({ code: "ATTACHMENT_URL" });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test("follows a validated CDN redirect manually with no retries", async () => {
  const requests: Request[] = [];
  fetchSpy.mockImplementation(async (input) => {
    const request = input as Request;
    requests.push(request);
    return requests.length === 1
      ? new Response(null, { status: 307, headers: { location: "https://media.discordapp.net/attachments/1/2/a.png" } })
      : new Response(new Uint8Array([1, 2, 3]));
  });
  const result = await stage([attachment()]);
  expect(requests.map((request) => request.redirect)).toEqual(["manual", "manual"]);
  expect(requests[1]!.url).toBe("https://media.discordapp.net/attachments/1/2/a.png");
  expect(await readFile(result[0]!.path)).toEqual(Buffer.from([1, 2, 3]));
});

test("bounds redirect loops and rejects missing redirect locations", async () => {
  fetchSpy.mockImplementation(async () => new Response(null, { status: 302, headers: { location: url } }));
  await expect(stage([attachment()])).rejects.toMatchObject({ code: "ATTACHMENT_REDIRECT" });
  expect(fetchSpy).toHaveBeenCalledTimes(6);
  fetchSpy.mockImplementation(async () => new Response(null, { status: 302 }));
  await expect(stage([attachment()])).rejects.toMatchObject({ code: "ATTACHMENT_REDIRECT" });
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test.each([-1, NaN, 1.5, Infinity, 20 * MiB + 1])("rejects declared size %s before download", async (size) => {
  await expect(stage([attachment({ size })])).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("rejects declared aggregate limits before download", async () => {
  await expect(stage([attachment({ size: 20 * MiB }), attachment({ size: 20 * MiB }), attachment({ size: 11 * MiB })]))
    .rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("accepts the exact per-file boundary and rejects a lying streamed oversize", async () => {
  fetchSpy.mockImplementation(async () => bytes(20 * MiB));
  const result = await stage([attachment({ size: 0 })]);
  expect((await stat(result[0]!.path)).size).toBe(20 * MiB);
  await rm(dirname(result[0]!.path), { recursive: true });
  fetchSpy.mockImplementation(async () => bytes(20 * MiB + 1));
  await expect(stage([attachment({ size: 0 })])).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test("enforces exact aggregate boundary and cleans the whole batch on streamed overflow", async () => {
  let index = 0;
  fetchSpy.mockImplementation(async () => bytes([20 * MiB, 20 * MiB, 10 * MiB][index++ % 3]!));
  const files = Array.from({ length: 3 }, () => attachment({ size: 0 }));
  const result = await stage(files);
  await rm(dirname(result[0]!.path), { recursive: true });
  index = 0;
  fetchSpy.mockImplementation(async () => bytes([20 * MiB, 20 * MiB, 10 * MiB + 1][index++ % 3]!));
  await expect(stage(files)).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test.each(["20971521", "garbage"])("rejects unsafe content-length %s and cleans partial batches", async (length) => {
  let requests = 0;
  fetchSpy.mockImplementation(async () => ++requests === 1
    ? new Response("first")
    : new Response("second", { headers: { "content-length": length } }));
  await expect(stage([attachment(), attachment()])).rejects.toMatchObject({ code: "ATTACHMENT_LIMIT" });
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test("stream failure after a previous completed file removes all partial files", async () => {
  let requests = 0;
  fetchSpy.mockImplementation(async () => ++requests === 1 ? new Response("first") : new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    pull(controller) {
      controller.error(new Error("connection broke"));
    },
  })));
  await expect(stage([attachment(), attachment()])).rejects.toThrow("connection broke");
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test("HTTP failure is not retried and removes earlier staged files", async () => {
  let requests = 0;
  fetchSpy.mockImplementation(async () => ++requests === 1 ? new Response("first") : new Response("unavailable", { status: 503 }));
  await expect(stage([attachment(), attachment()])).rejects.toMatchObject({ code: "ATTACHMENT_HTTP" });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(await readdir(join(directory, "attachments"))).toEqual([]);
});

test("body deadline aborts a stalled stream and cleans up without waiting in real time", async () => {
  const timerSpy = spyOn(globalThis, "setTimeout");
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  fetchSpy.mockImplementation(async () => new Response(new ReadableStream({
    pull() { started.resolve(); },
    cancel() { cancelled.resolve(); },
  }, { highWaterMark: 0 })));
  try {
    const pending = stage([attachment()]);
    const outcome = pending.then(
      () => ({ failed: false }),
      (error: unknown) => ({ failed: true, error }),
    );
    await started.promise;
    const deadline = timerSpy.mock.calls.find(([, delay]) => delay === 30_000);
    expect(deadline).toBeDefined();
    deadline![0]();
    expect(await outcome).toMatchObject({ failed: true });
    await cancelled.promise;
    expect(await readdir(join(directory, "attachments"))).toEqual([]);
  } finally {
    timerSpy.mockRestore();
  }
});

test("refuses symlinked storage roots without touching the target", async () => {
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "untouched");
  await symlink(outside, join(directory, "attachments"), process.platform === "win32" ? "junction" : "dir");
  await expect(stage([attachment()])).rejects.toMatchObject({ code: "UNSAFE_STORAGE" });
  expect(await readdir(outside)).toEqual(["keep"]);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("refuses a file in place of the storage directory", async () => {
  await writeFile(join(directory, "attachments"), "keep");
  await expect(stage([attachment()])).rejects.toMatchObject({ code: "UNSAFE_STORAGE" });
  expect(await readFile(join(directory, "attachments"), "utf8")).toBe("keep");
});

test("empty input creates no storage or network activity", async () => {
  expect(await stage([])).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

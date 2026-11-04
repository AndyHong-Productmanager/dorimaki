import { randomUUID } from "node:crypto";
import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import ky from "ky";
import { DorimakiError, type Attachment, type LocalAttachment } from "../contracts";
import { storageRoot } from "./storage";

const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 50 * 1024 * 1024;
const FILE_TIMEOUT_MS = 30_000;
const REDIRECT_LIMIT = 5;

function attachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DorimakiError("ATTACHMENT_URL", "Invalid attachment URL");
  }
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !/^\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/[^/]+$/.test(url.pathname)
  ) {
    throw new DorimakiError("ATTACHMENT_URL", "Only HTTPS Discord CDN attachment URLs are allowed");
  }
  let filename: string;
  try {
    filename = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
  } catch {
    throw new DorimakiError("ATTACHMENT_URL", "Invalid attachment URL encoding");
  }
  if (/[\\/\p{Cc}]/u.test(filename) || filename === "." || filename === "..") {
    throw new DorimakiError("ATTACHMENT_URL", "Unsafe attachment URL filename");
  }
  return url;
}

function safeName(value: string): string {
  const basename = value.split(/[\\/]/).at(-1) ?? "";
  const name = basename
    .replace(/[<>:"|?*\p{Cc}]/gu, "_")
    .replace(/[ .]+$/g, "")
    .slice(0, 120)
    .replace(/[ .]+$/g, "");
  if (!name || /^\.+$/.test(name)) return "attachment";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

async function download(url: URL, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; ; redirects++) {
    const response = await ky.get(url, {
      redirect: "manual",
      retry: 0,
      timeout: FILE_TIMEOUT_MS,
      signal,
      throwHttpErrors: false,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects >= REDIRECT_LIMIT) {
        throw new DorimakiError("ATTACHMENT_REDIRECT", "Attachment redirect limit or missing location");
      }
      url = attachmentUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DorimakiError("ATTACHMENT_HTTP", `Attachment download returned HTTP ${response.status}`);
    }
    return response;
  }
}

export async function stageAttachments(input: {
  dataDir: string;
  messageId: string;
  files: readonly Attachment[];
}): Promise<readonly LocalAttachment[]> {
  let declaredTotal = 0;
  const files = input.files.map((file) => {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_LIMIT) {
      throw new DorimakiError("ATTACHMENT_LIMIT", "Attachment exceeds the 20 MiB per-file limit");
    }
    declaredTotal += file.size;
    if (declaredTotal > TOTAL_LIMIT) {
      throw new DorimakiError("ATTACHMENT_LIMIT", "Attachments exceed the 50 MiB total limit");
    }
    return { file, url: attachmentUrl(file.url) };
  });
  if (input.files.length === 0) return [];
  const root = await storageRoot(input.dataDir, "attachments");
  const staging = await mkdtemp(join(root, ".staging-"));
  const destination = join(root, randomUUID());
  const staged: LocalAttachment[] = [];
  let totalBytes = 0;
  try {
    for (const [index, { file, url }] of files.entries()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Attachment download timed out")), FILE_TIMEOUT_MS);
      try {
        const response = await download(url, controller.signal);
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > FILE_LIMIT || Number(length) + totalBytes > TOTAL_LIMIT)) {
          await response.body?.cancel();
          throw new DorimakiError("ATTACHMENT_LIMIT", "Attachment content-length exceeds download limits");
        }
        if (!response.body) throw new DorimakiError("ATTACHMENT_BODY", "Attachment response has no body");
        const name = safeName(file.name);
        const filename = `${index}-${name}`;
        let fileBytes = 0;
        const reader = response.body.getReader();
        try {
          const output = await open(join(staging, filename), "wx", 0o600);
          try {
            while (true) {
              controller.signal.throwIfAborted();
              const aborted = Promise.withResolvers<never>();
              const onAbort = () => aborted.reject(new DorimakiError("ATTACHMENT_TIMEOUT", "Attachment download timed out"));
              controller.signal.addEventListener("abort", onAbort, { once: true });
              let chunk: Awaited<ReturnType<typeof reader.read>>;
              try {
                chunk = await Promise.race([reader.read(), aborted.promise]);
              } finally {
                controller.signal.removeEventListener("abort", onAbort);
              }
              if (chunk.done) break;
              fileBytes += chunk.value.byteLength;
              totalBytes += chunk.value.byteLength;
              if (fileBytes > FILE_LIMIT || totalBytes > TOTAL_LIMIT) {
                throw new DorimakiError("ATTACHMENT_LIMIT", "Streamed attachments exceed download limits");
              }
              await output.writeFile(chunk.value);
            }
          } finally {
            await output.close();
          }
        } finally {
          try {
            await reader.cancel();
          } finally {
            reader.releaseLock();
          }
        }
        controller.signal.throwIfAborted();
        staged.push({
          path: join(destination, filename),
          name,
          contentType: file.contentType ?? response.headers.get("content-type") ?? "application/octet-stream",
        });
      } finally {
        clearTimeout(timer);
      }
    }
    await rename(staging, destination);
    return staged;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

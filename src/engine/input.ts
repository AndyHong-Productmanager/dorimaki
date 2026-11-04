import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DorimakiError, type LocalAttachment } from "../contracts";

export async function encodeInput(text: string, attachments: readonly LocalAttachment[]) {
  let message = text;
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (const attachment of attachments) {
    const path = resolve(attachment.path);
    if (!(await stat(path)).isFile()) {
      throw new DorimakiError("engine_attachment", `Not a file: ${attachment.name}`);
    }
    if (attachment.contentType.startsWith("image/")) {
      images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType: attachment.contentType });
    } else {
      message += `\n\nAttached local file (use the read tool or appropriate file tool to inspect it): ${JSON.stringify({ path, name: attachment.name, contentType: attachment.contentType })}`;
    }
  }
  return { message, ...(images.length ? { images } : {}) };
}

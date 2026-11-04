import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { DorimakiError, type Engine } from "../contracts";
import { storageRoot } from "../media/storage";

// The artifact is a local, potentially unredacted export, not a public share URL.
// Its caller owns removal of the returned file's private parent after upload.
export async function createShare(input: {
  engine: Engine;
  sessionFile: string;
  dataDir: string;
}): Promise<string> {
  const root = await storageRoot(input.dataDir, "shares");
  const directory = await mkdtemp(join(root, "export-"));
  const output = join(directory, "conversation.html");
  try {
    await input.engine.exportHtml(input.sessionFile, output);
    const info = await lstat(output);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new DorimakiError("SHARE_EXPORT", "Engine export must produce a regular HTML file");
    }
    const file = await open(output, "r");
    try {
      const { bytesRead } = await file.read(Buffer.alloc(1), 0, 1, 0);
      if (bytesRead === 0) throw new DorimakiError("SHARE_EXPORT", "Engine export produced an empty file");
    } finally {
      await file.close();
    }
    return output;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

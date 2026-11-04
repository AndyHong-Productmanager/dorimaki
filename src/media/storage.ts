import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DorimakiError } from "../contracts";

// dataDir is operator-owned. Never follow a pre-existing link for our child roots.
export async function storageRoot(dataDir: string, area: "attachments" | "shares"): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const base = await realpath(dataDir);
  const path = join(base, area);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new DorimakiError("UNSAFE_STORAGE", `${area} storage must be a real directory`);
  }
  return path;
}

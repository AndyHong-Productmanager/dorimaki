import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DorimakiError, type Config, type Engine } from "../contracts";
import { catalogExtension } from "./catalog";
import { childEnvironment, RpcProcess } from "./rpc";
import { Session } from "./session";

async function run(executable: string, args: readonly string[]): Promise<string> {
  const child = spawn(executable, args, { env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output = (output + chunk).slice(-1024 * 1024); });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    return await new Promise((resolveOutput, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolveOutput(output.trim());
        else reject(new DorimakiError("engine_exit", `omo command exited (${code})`));
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

export function createEngine(config: Config): Engine {
  const root = resolve(config.dataDir, "engine");
  let extensionPath: Promise<string> | undefined;
  return {
    async open(input) {
      if (!isAbsolute(input.directory)) throw new DorimakiError("engine_directory", "Project directory must be absolute");
      extensionPath ??= (async () => {
        await mkdir(root, { recursive: true });
        const extension = join(root, "catalog-extension.mjs");
        await writeFile(extension, catalogExtension, "utf8");
        return extension;
      })();
      const extension = await extensionPath;
      const args = [config.omoPath, "--mode", "rpc", "--session-dir", join(root, "sessions"), "--extension", extension];
      switch (input.mode.kind) {
        case "create":
          args.push("--session-id", crypto.randomUUID());
          break;
        case "resume":
        case "fork":
          if (!isAbsolute(input.mode.sessionFile)) throw new DorimakiError("engine_session", "Session file must be absolute");
          await stat(input.mode.sessionFile);
          args.push(input.mode.kind === "resume" ? "--session" : "--fork", input.mode.sessionFile);
          break;
      }
      const rpc = new RpcProcess(args, input.directory);
      const session = new Session(rpc);
      try {
        await session.initialize(input.mode.kind === "create");
        return session;
      } catch (cause) {
        await rpc.close();
        throw cause;
      }
    },
    async exportHtml(sessionFile, outputPath) {
      await stat(sessionFile);
      await mkdir(dirname(resolve(outputPath)), { recursive: true });
      await run(config.omoPath, ["--export", resolve(sessionFile), resolve(outputPath)]);
      if (!(await stat(outputPath)).isFile()) throw new DorimakiError("engine_export", "omo did not create an HTML export");
    },
    version() {
      return run(config.omoPath, ["--version"]);
    },
  };
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { DorimakiError } from "../contracts";

export type Frame = Record<string, unknown>;

/** Keep account/model configuration, but never inherit a connection to our caller. */
export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:OMO|SENPI)_RPC_/.test(key) ||
      /^(?:PI|OMO|SENPI)_SESSION_(?:ID|FILE|CWD)$/.test(key) ||
      /^(?:OMO|SENPI)_(?:TASK|PARENT|CHILD|RUN)_/.test(key) ||
      /^(?:OMO|SENPI)_INTERNAL_ROLE$/.test(key) ||
      key === "PI_GOAL_STORE_FILE" ||
      key === "DISCORD_BOT_TOKEN"
    ) {
      delete env[key];
    }
  }
  return env;
}

type Pending = {
  command: string;
  resolve: (data: Frame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  readonly exited: Promise<void>;
  onEvent: (frame: Frame) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(
    command: readonly string[],
    cwd: string,
    env = childEnvironment(),
    private readonly timeoutMs = 60_000,
  ) {
    const executable = command[0];
    if (!executable) throw new DorimakiError("engine_spawn", "Missing omo executable");
    this.child = spawn(executable, command.slice(1), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Drain stderr without echoing credentials, provider headers, or prompt content.
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    this.child.stdout.on("end", () => {
      this.consume(this.decoder.end());
      this.fail(new DorimakiError("engine_eof", this.buffer.trim()
        ? "omo closed stdout with an incomplete RPC frame"
        : "omo closed its RPC stream"));
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.fail(new DorimakiError("engine_exit", `omo exited (${signal ?? code})`));
        resolve();
      });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.fail(new DorimakiError("engine_protocol", "RPC frame exceeds 32 MiB"));
      this.child.kill();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line);
        if (!frame || typeof frame !== "object" || typeof frame["type"] !== "string") {
          throw new Error("Missing RPC frame type");
        }
      } catch {
        this.fail(new DorimakiError("engine_protocol", "Invalid omo NDJSON frame"));
        this.child.kill();
        return;
      }
      if (frame["type"] === "response") {
        const id = frame["id"];
        const pending = typeof id === "string" ? this.pending.get(id) : undefined;
        if (!pending) {
          if (frame["success"] === false && frame["id"] === undefined) {
            this.fail(new DorimakiError(
              typeof frame["errorCode"] === "string" ? frame["errorCode"] : "engine_rpc",
              typeof frame["error"] === "string" ? frame["error"] : "Uncorrelated RPC failure",
            ));
          }
          continue;
        }
        if (typeof id === "string") this.pending.delete(id);
        clearTimeout(pending.timer);
        if (frame["command"] !== pending.command) {
          pending.reject(new DorimakiError("engine_protocol", "RPC response command does not match its request"));
        } else if (frame["success"] !== true) {
          pending.reject(new DorimakiError(
            typeof frame["errorCode"] === "string" ? frame["errorCode"] : "engine_rpc",
            typeof frame["error"] === "string" ? frame["error"] : "omo request failed",
          ));
        } else {
          const data = frame["data"];
          if (data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
            pending.reject(new DorimakiError("engine_protocol", "Expected an RPC response data object"));
          } else {
            pending.resolve(data === undefined ? {} : Object.fromEntries(Object.entries(data)));
          }
        }
      } else {
        this.onEvent(frame);
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
  }

  request(type: string, fields: Frame = {}): Promise<Frame> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `dorimaki-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DorimakiError("engine_timeout", `omo ${type} request timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { command: type, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...fields, type, id })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.fail(new DorimakiError("engine_closed", "Engine session closed"));
      this.child.stdin.end();
      const deadline = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
      try {
        await this.exited;
      } finally {
        clearTimeout(deadline);
      }
    })();
    return this.closing;
  }
}

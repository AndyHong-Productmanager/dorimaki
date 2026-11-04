import { stat } from "node:fs/promises";
import { z } from "zod";
import {
  DorimakiError,
  type EngineEvent,
  type EngineIdentity,
  type EngineSession,
  type LocalAttachment,
} from "../contracts";
import { readCatalog } from "./catalog";
import { eventSchema, knownEvents } from "./events";
import { RpcProcess, type Frame } from "./rpc";
import { encodeInput } from "./input";

const identitySchema = z.object({ sessionId: z.string().min(1), sessionFile: z.string().min(1) });
const blockingDialogs = new Set(["select", "confirm", "input", "editor", "question", "custom_unsupported"]);
const presentationMethods = new Set(["notify", "setStatus", "setSubagentCost", "setWidget", "setTitle", "set_editor_text"]);

type Turn = {
  readonly onEvent: (event: EngineEvent) => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly background: boolean;
  readonly promise: Promise<void>;
  accepted: boolean;
  idle: boolean;
  streamed: string;
  failure: Error | undefined;
  ended: boolean;
  submitted: boolean;
};

export class Session implements EngineSession {
  private turn: Turn | undefined;
  private closed = false;
  private startupFailure: Error | undefined;

  private sessionIdentity: EngineIdentity | undefined;
  private readonly observers = new Set<(event: EngineEvent) => void>();

  constructor(private readonly rpc: RpcProcess) {
    rpc.onEvent = (frame) => this.event(frame);
    rpc.onFailure = (error) => {
      this.closed = true;
      this.finish(error);
    };
  }

  get identity(): EngineIdentity {
    if (!this.sessionIdentity) throw new DorimakiError("engine_starting", "Engine identity is not ready");
    return this.sessionIdentity;
  }

  onBackgroundEvent(listener: (event: EngineEvent) => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  private createTurn(onEvent: (event: EngineEvent) => void, background: boolean): Turn {
    const completion = Promise.withResolvers<void>();
    return {
      ...completion, background, onEvent,
      // Background errors are delivered to observers, not an unowned rejected promise.
      reject: background ? () => completion.resolve() : completion.reject,
      timer: setTimeout(() => {
        this.finish(new DorimakiError("engine_turn_timeout", "omo turn exceeded 30 minutes"));
        void this.close();
      }, 30 * 60_000),
      accepted: background, idle: false, streamed: "", failure: undefined,
      ended: false, submitted: background,
    };
  }

  async initialize(persist: boolean): Promise<void> {
    this.sessionIdentity = identitySchema.parse(await this.rpc.request("get_state"));
    if (persist) {
      await this.rpc.request("extension_request", { name: "dorimaki.persist" });
      await stat(this.sessionIdentity.sessionFile);
    }
    if (this.startupFailure) throw this.startupFailure;
  }

  private finish(error?: Error): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    clearTimeout(turn.timer);
    if (error) turn.onEvent({ kind: "error", message: error.message });
    turn.onEvent({ kind: "end" });
    if (error) turn.reject(error);
    else turn.resolve();
  }

  private settle(): void {
    const turn = this.turn;
    if (turn?.accepted && turn.idle) this.finish(turn.failure);
  }

  private event(frame: Frame): void {
    if (!knownEvents.has(String(frame["type"]))) return;
    const result = eventSchema.safeParse(frame);
    if (!result.success) {
      this.finish(new DorimakiError("engine_protocol", `Malformed native ${String(frame["type"])} event: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`));
      return;
    }
    const event = result.data;
    if (event.type === "agent_start" && !this.turn) {
      this.turn = this.createTurn((output) => {
        for (const observer of this.observers) observer(output);
      }, true);
    }
    const turn = this.turn;
    switch (event.type) {
      case "commands_changed":
      case "loaded_surfaces_changed":
        if (turn) turn.onEvent({ kind: "catalog-changed" });
        else for (const observer of this.observers) observer({ kind: "catalog-changed" });
        return;
      case "extension_ui_request":
        if (!presentationMethods.has(event.method)) {
          const error = new DorimakiError("engine_approval_required", `omo requires interactive ${event.method}; this client cannot grant approvals`);
          this.startupFailure = turn ? undefined : error;
          // Native cancellation is not an approval, and prevents a pending dialog
          // from pinning this headless process indefinitely.
          if (turn) turn.failure = error;
          void (async () => {
            try {
              if (blockingDialogs.has(event.method)) {
                await this.rpc.request("extension_ui_response", { uiRequestId: event.id, cancelled: true });
              }
              await this.rpc.request("interrupt");
              this.finish(error);
            } catch (cause) {
              this.finish(cause instanceof Error ? cause : error);
            }
          })();
        } else if (event.method === "notify" && event.message) {
          turn?.onEvent({ kind: "activity", text: event.message });
        } else if (event.method === "setStatus" && event.statusText) {
          turn?.onEvent({ kind: "activity", text: event.statusText });
        }
        return;
      case "rpc_error":
        this.finish(new DorimakiError("engine_rpc", event.error));
        return;
      case "session_closed":
        this.closed = true;
        this.finish(new DorimakiError("engine_closed", "omo closed the session"));
        return;
      case "message_start":
        if (turn && event.message.role === "assistant") turn.streamed = "";
        return;
      case "message_update":
        if (turn && event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta) {
          turn.streamed += event.assistantMessageEvent.delta;
          turn.onEvent({ kind: "text", text: event.assistantMessageEvent.delta });
        }
        return;
      case "message_end": {
        if (!turn || event.message.role !== "assistant") return;
        const text = typeof event.message.content === "string" ? event.message.content
          : event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
        if (text.startsWith(turn.streamed)) {
          const suffix = text.slice(turn.streamed.length);
          if (suffix) turn.onEvent({ kind: "text", text: suffix });
        } else {
          turn.failure = new DorimakiError("engine_protocol", "Final assistant text differs from the streamed text");
        }
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          turn.failure = new DorimakiError("engine_turn_failed", event.message.errorMessage ?? `omo turn ${event.message.stopReason}`);
        }
        return;
      }
      case "agent_start":
        if (turn) {
          turn.idle = false;
          turn.ended = false;
        }
        return;
      case "agent_end":
        if (!turn) return;
        if (event.willRetry) {
          turn.failure = undefined;
        } else if (event.aborted) {
          turn.failure = new DorimakiError("engine_interrupted", "omo turn interrupted");
        } else {
          const last = event.messages?.at(-1);
          if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
            turn.failure = new DorimakiError("engine_turn_failed", last.errorMessage ?? "omo turn failed");
          }
        }
        turn.ended = !event.willRetry;
        return;
      case "agent_idle":
        if (turn?.ended) {
          turn.idle = true;
          this.settle();
        }
        return;
      case "tool_execution_start":
        turn?.onEvent({ kind: "activity", text: `Running ${event.toolName}` });
        return;
      case "tool_execution_end":
        turn?.onEvent({ kind: "activity", text: `${event.toolName} ${event.isError ? "failed" : "finished"}` });
        return;
    }
  }

  async prompt(input: {
    readonly text: string;
    readonly attachments: readonly LocalAttachment[];
    readonly onEvent: (event: EngineEvent) => void;
  }): Promise<void> {
    if (this.turn?.background) await this.turn.promise;
    if (this.closed) throw new DorimakiError("engine_closed", "Engine session is closed");
    if (this.startupFailure) throw this.startupFailure;
    if (this.turn) throw new DorimakiError("engine_busy", "Engine session already has an active turn");
    // Reserve before reading attachments so concurrent inputs cannot race.
    const turn = this.createTurn(input.onEvent, false);
    this.turn = turn;
    void (async () => {
      try {
        const encoded = await encodeInput(input.text, input.attachments);
        if (this.turn !== turn) return;
        turn.submitted = true;
        const acceptance = await this.rpc.request("prompt", {
          ...encoded,
          clientMessageId: crypto.randomUUID(),
        });
        if (this.turn !== turn) return;
        turn.accepted = true;
        // A synchronous slash command is terminal without starting an agent.
        // Its native "handled" disposition is distinct from accepted generation.
        if (acceptance["disposition"] === "handled") turn.idle = true;
        this.settle();
      } catch (cause) {
        if (this.turn !== turn) return;
        this.finish(cause instanceof Error ? cause : new DorimakiError("engine_rpc", String(cause)));
        if (cause instanceof DorimakiError && cause.code === "engine_timeout") await this.close();
      }
    })();
    return turn.promise;
  }

  async interrupt(): Promise<void> {
    if (this.turn && !this.turn.submitted) {
      this.finish(new DorimakiError("engine_interrupted", "omo turn interrupted before submission"));
      return;
    }
    await this.rpc.request("interrupt");
  }

  catalog() {
    return readCatalog(this.rpc);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.finish(new DorimakiError("engine_closed", "Engine session closed"));
    await this.rpc.close();
  }
}

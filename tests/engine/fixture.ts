import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const inputSchema = z.object({ type: z.string(), id: z.string(), message: z.string().optional() }).passthrough();
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("omo fixture 1");
  process.exit(0);
}
if (args.includes("--export")) {
  const index = args.indexOf("--export");
  const source = args[index + 1];
  const output = args[index + 2];
  if (!source || !output) process.exit(1);
  const session = JSON.parse(await readFile(source, "utf8"));
  await writeFile(output, `<html><body>${session.sessionId}</body></html>`);
  process.exit(0);
}
const sessionIndex = args.indexOf("--session");
const forkIndex = args.indexOf("--fork");
const sessionFile = join(process.cwd(), "fixture-session.jsonl");
const resumeFile = args[sessionIndex + 1];
const forkFile = args[forkIndex + 1];
let identity = { sessionId: "created", sessionFile };
if (sessionIndex >= 0 && resumeFile) identity = JSON.parse(await readFile(resumeFile, "utf8"));
if (forkIndex >= 0 && forkFile) identity = { sessionId: "forked", sessionFile: join(process.cwd(), "forked.jsonl") };
if (sessionIndex >= 0 || forkIndex >= 0) await writeFile(identity.sessionFile, JSON.stringify(identity));

function send(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function response(id: string, command: string, data: unknown = {}) {
  send({ type: "response", id, command, success: true, data });
}
function end(error?: string) {
  const message = { role: "assistant", content: [], stopReason: error ? "error" : "stop", ...(error ? { errorMessage: error } : {}) };
  send({ type: "message_end", message });
  send({ type: "agent_end", messages: [message], willRetry: false });
  send({ type: "agent_idle" });
}
let pendingPrompt: { id: string; command: string } | undefined;
let pendingCommands: { id: string; command: string } | undefined;
let sawCancellation = false;
let pendingApproval = false;
let pendingBackground = false;

for await (const line of createInterface({ input: process.stdin })) {
  const input = inputSchema.parse(JSON.parse(line));
  switch (input.type) {
    case "get_state":
      response(input.id, input.type, identity);
      break;
    case "get_commands":
      pendingCommands = { id: input.id, command: input.type };
      break;
    case "extension_request":
      if (input["name"] === "dorimaki.persist") {
        await writeFile(identity.sessionFile, JSON.stringify(identity));
        response(input.id, input.type);
        break;
      }
      response(input.id, input.type, { taskDescription: "Spawn one child task or fan out a batch.\n- subagent_type invokes a loaded agent directly. Available agents: explore, librarian\n" });
      if (pendingCommands) response(pendingCommands.id, pendingCommands.command, {
        commands: [
          { name: "inspect", description: "Inspect", source: "extension", syntax: "slash" },
          { name: "skill:paint", description: "Paint", source: "skill", syntax: "dollar" },
        ],
      });
      pendingCommands = undefined;
      if (pendingBackground) {
        pendingBackground = false;
        send({ type: "agent_start" });
        if (process.env["FIXTURE_BACKGROUND_WAIT"] === "1") {
          send({ type: "tool_execution_start", toolName: "background-ready" });
          pendingPrompt = { id: input.id, command: input.type };
        } else {
          send({ type: "message_start", message: { role: "assistant", content: [] } });
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Completed delegated work" } });
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Completed delegated work" }], stopReason: "stop" } });
          send({ type: "agent_end", willRetry: false });
          send({ type: "agent_idle" });
        }
      }
      break;
    case "prompt": {
      if (input.message === "delegate") {
        pendingBackground = true;
        response(input.id, input.type, { disposition: "handled" });
        break;
      }
      if (input.message === "reject") {
        send({ type: "response", id: input.id, command: input.type, success: false, errorCode: "provider_credentials_missing", error: "No credentials" });
        break;
      }
      if (input.message === "eof") { process.exit(0); }
      if (input.message === "malformed") { process.stdout.write("not-json\n"); break; }
      if (input.message === "partial") { process.stdout.write('{"type":'); process.exit(0); }
      if (input.message === "mismatch") { response(input.id, "wrong"); break; }
      if (input.message === "approval") {
        pendingApproval = true;
        send({ type: "extension_ui_request", id: "approval-1", method: "select", title: "Permission", options: ["Approve", "Deny"] });
        break;
      }
      if (input.message === "handled") {
        response(input.id, input.type, { disposition: "handled" });
        break;
      }
      send({ type: "agent_start" });
      if (input.message === "wait") {
        response(input.id, input.type, { disposition: "started" });
        send({ type: "tool_execution_start", toolName: "fixture-ready" });
        pendingPrompt = { id: input.id, command: input.type };
        break;
      }
      if (input.message === "early-ack") {
        response(input.id, input.type, { disposition: "started" });
        send({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
        send({ type: "tool_execution_start", toolName: "fixture-ready" });
        pendingPrompt = { id: input.id, command: input.type };
        break;
      }
      if (input.message === "fail") {
        response(input.id, input.type, { disposition: "started" });
        end("Provider failed");
        break;
      }
      const text = input.message?.startsWith("attachments") ? JSON.stringify({
        images: input["images"],
        message: input.message,
      }) : "Hello 한글";
      send({ type: "message_start", message: { role: "assistant", content: [] } });
      // Split the UTF-8 character itself across writes, then coalesce frames.
      const delta = Buffer.from(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } })}\n`);
      const split = delta.indexOf(Buffer.from("한")) + 1;
      process.stdout.write(delta.subarray(0, split > 0 ? split : 3));
      process.stdout.write(delta.subarray(split > 0 ? split : 3));
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
      if (input.message === "retry") {
        send({ type: "agent_end", willRetry: true });
        send({ type: "agent_idle" }); // A retry must not finish the prompt.
        send({ type: "agent_start" });
        send({ type: "message_start", message: { role: "assistant", content: [] } });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Retry completed" }], stopReason: "stop" } });
      }
      send({ type: "agent_end", willRetry: false, messages: [] });
      send({ type: "agent_idle" });
      // Exercise terminal events arriving before prompt acceptance.
      response(input.id, input.type, { disposition: "started" });
      break;
    }
    case "extension_ui_response":
      sawCancellation = input["cancelled"] === true && input["uiRequestId"] === "approval-1";
      response(input.id, input.type, { cancelled: sawCancellation });
      break;
    case "interrupt":
      if (pendingApproval && !sawCancellation) {
        send({ type: "response", id: input.id, command: input.type, success: false, errorCode: "fixture_approval_not_cancelled", error: "The approval was not cancelled" });
        break;
      }
      if (pendingPrompt) {
        if (process.env["FIXTURE_EARLY_END"] === "1") {
          end();
        } else {
          send({ type: "agent_end", aborted: true, willRetry: false });
          send({ type: "agent_idle" });
        }
        pendingPrompt = undefined;
      }
      response(input.id, input.type, { interrupted: true });
      break;
    case "inspect_env":
      response(input.id, input.type, {
        parentSocket: process.env["OMO_RPC_SOCKET_PATH"] ?? null,
        parentSession: process.env["PI_SESSION_ID"] ?? null,
        accountDirectory: process.env["SENPI_CODING_AGENT_DIR"] ?? null,
        providerKey: process.env["DORIMAKI_FIXTURE_PROVIDER_KEY"] ?? null,
        discordTokenPresent: process.env["DISCORD_BOT_TOKEN"] !== undefined,
        cancelled: sawCancellation,
      });
      break;
    case "finish":
      end();
      response(input.id, input.type);
      break;
    default:
      send({ type: "response", id: input.id, command: input.type, success: false, error: "unsupported" });
  }
}

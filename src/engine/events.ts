import { z } from "zod";

const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]).optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: messageSchema }),
  z.object({ type: z.literal("message_update"), assistantMessageEvent: z.object({ type: z.string(), delta: z.string().optional() }).passthrough() }),
  z.object({ type: z.literal("message_end"), message: messageSchema }),
  z.object({ type: z.literal("agent_start") }),
  z.object({ type: z.literal("agent_end"), willRetry: z.boolean().optional(), aborted: z.boolean().optional(), messages: z.array(messageSchema).optional() }),
  z.object({ type: z.literal("agent_idle") }),
  z.object({ type: z.literal("tool_execution_start"), toolName: z.string() }),
  z.object({ type: z.literal("tool_execution_end"), toolName: z.string(), isError: z.boolean().optional() }),
  z.object({ type: z.literal("commands_changed") }),
  z.object({ type: z.literal("loaded_surfaces_changed") }),
  z.object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.string(), message: z.string().optional(), statusText: z.string().optional() }),
  z.object({ type: z.literal("rpc_error"), error: z.string() }),
  z.object({ type: z.literal("session_closed") }),
]);

export const knownEvents = new Set<string>(eventSchema.options.map((schema) => schema.shape.type.value));

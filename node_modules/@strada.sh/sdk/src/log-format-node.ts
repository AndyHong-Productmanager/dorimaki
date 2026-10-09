/**
 * Node.js log value formatter. Uses node:util.inspect so console-style SDK logs
 * match Node console output more closely than JSON.stringify.
 */

import { inspect } from "node:util";

export const MAX_LOG_STRING_LENGTH = 16_384;

export function truncateLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) return value;
  const omitted = value.length - MAX_LOG_STRING_LENGTH;
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}… [truncated ${omitted} chars]`;
}

export function formatLogValue(value: unknown): string {
  if (typeof value === "string") return truncateLogString(value);
  return inspect(value, {
    colors: false,
    compact: true,
    breakLength: Infinity,
    depth: 5,
    maxStringLength: MAX_LOG_STRING_LENGTH,
    maxArrayLength: 100,
  });
}

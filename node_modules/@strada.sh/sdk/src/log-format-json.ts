/**
 * Cross-runtime log value formatter. Used by browser and Workers builds where
 * node:util is not available.
 */

export const MAX_LOG_STRING_LENGTH = 16_384;

export function truncateLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) return value;
  const omitted = value.length - MAX_LOG_STRING_LENGTH;
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}… [truncated ${omitted} chars]`;
}

export function formatLogValue(value: unknown): string {
  if (typeof value === "string") return truncateLogString(value);
  if (value instanceof Error) return truncateLogString(value.stack || value.message);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return value.name ? `[Function: ${value.name}]` : "[Function]";
  if (value === undefined) return "undefined";
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "string") return truncateLogString(nested);
      if (typeof nested === "bigint") return nested.toString();
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
    return json === undefined ? truncateLogString(String(value)) : json;
  } catch {
    return truncateLogString(String(value));
  }
}

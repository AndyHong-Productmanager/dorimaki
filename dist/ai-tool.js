// Minimal tool definition helper used by Dorimaki.
// This replaces the Vercel AI SDK `tool()` helper so Dorimaki can define typed
// tools (Zod input schema + execute) without depending on the full `ai` package.
export function tool(definition) {
    return definition;
}

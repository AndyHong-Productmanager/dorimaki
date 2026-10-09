// Adds description and hasSideEffect to the built-in bash tool schema.
// Uses tool.definition so OpenCode keeps the real bash execute.
// Assign jsonSchema only. Leave parameters as the Effect Schema used to decode
// args before execute. Extra fields stay in the model-facing schema and in
// Discord input; they never reach the shell.
//
// Also injects DORIMAKI_SESSION_ID into bash env. /btw and /fork clone parent
// history, so the copied system prompt still says --session <parent>. Upload
// then prefers this live env over that stale flag.
import { z } from 'zod';
export const DORIMAKI_SESSION_ID_ENV = 'DORIMAKI_SESSION_ID';
export function injectDorimakiSessionEnv({ sessionID, env, }) {
    if (!sessionID)
        return;
    env[DORIMAKI_SESSION_ID_ENV] = sessionID;
}
export function resolveUploadToDiscordSessionId({ flagSessionId, envSessionId = process.env[DORIMAKI_SESSION_ID_ENV], } = {}) {
    if (envSessionId)
        return envSessionId;
    return flagSessionId;
}
export const bashParameters = z.object({
    command: z.string().describe('The command to execute'),
    description: z
        .string()
        .describe('Short 5-10 word summary shown in Discord when the command is longer than 50 characters'),
    hasSideEffect: z
        .boolean()
        .describe('True if the command writes files, modifies state, installs packages, or triggers external effects'),
    workdir: z
        .string()
        .optional()
        .describe('Working directory. Defaults to the current directory.'),
    timeout: z.number().int().optional().describe('Optional timeout in milliseconds'),
});
export function extendBashToolDefinition(output) {
    output.jsonSchema = z.toJSONSchema(bashParameters);
}
export const bashToolSchemaPlugin = async () => {
    return {
        'tool.definition': async (input, output) => {
            if (input.toolID !== 'bash')
                return;
            extendBashToolDefinition(output);
        },
        'shell.env': async (input, output) => {
            injectDorimakiSessionEnv({ sessionID: input.sessionID, env: output.env });
        },
    };
};

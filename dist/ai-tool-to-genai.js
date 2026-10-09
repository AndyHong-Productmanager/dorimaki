// Tool definition to Google GenAI tool converter.
// Transforms Dorimaki's minimal Tool definitions into Google GenAI CallableTool format
// for use with Gemini's function calling in the voice assistant.
import { Type } from '@google/genai';
import { toJSONSchema } from 'zod';
/**
 * Convert JSON Schema to GenAI Schema format
 * Based on the actual implementation used by the GenAI package:
 * https://github.com/googleapis/js-genai/blob/027f09db662ce6b30f737b10b4d2efcb4282a9b6/src/_transformers.ts#L294
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function jsonSchemaToGenAISchema(jsonSchema) {
    const schema = {};
    if (typeof jsonSchema === 'boolean') {
        return schema;
    }
    const jsonSchemaType = (() => {
        if (!jsonSchema.type) {
            return undefined;
        }
        if (typeof jsonSchema.type === 'string') {
            return jsonSchema.type;
        }
        if (Array.isArray(jsonSchema.type)) {
            return jsonSchema.type.find((t) => t !== 'null') || jsonSchema.type[0];
        }
        return undefined;
    })();
    if (Array.isArray(jsonSchema.type) && jsonSchema.type.includes('null')) {
        schema.nullable = true;
    }
    if (jsonSchemaType) {
        switch (jsonSchemaType) {
            case 'string':
                schema.type = Type.STRING;
                break;
            case 'number':
                schema.type = Type.NUMBER;
                schema.format =
                    typeof jsonSchema.format === 'string' ? jsonSchema.format : 'float';
                break;
            case 'integer':
                schema.type = Type.INTEGER;
                schema.format =
                    typeof jsonSchema.format === 'string' ? jsonSchema.format : 'int32';
                break;
            case 'boolean':
                schema.type = Type.BOOLEAN;
                break;
            case 'array': {
                schema.type = Type.ARRAY;
                const itemsSchema = (() => {
                    if (!jsonSchema.items) {
                        return undefined;
                    }
                    if (Array.isArray(jsonSchema.items)) {
                        return jsonSchema.items[0];
                    }
                    return jsonSchema.items;
                })();
                if (itemsSchema) {
                    schema.items = jsonSchemaToGenAISchema(itemsSchema);
                }
                if (typeof jsonSchema.minItems === 'number') {
                    schema.minItems = String(jsonSchema.minItems);
                }
                if (typeof jsonSchema.maxItems === 'number') {
                    schema.maxItems = String(jsonSchema.maxItems);
                }
                break;
            }
            case 'object':
                schema.type = Type.OBJECT;
                if (jsonSchema.properties) {
                    schema.properties = Object.fromEntries(Object.entries(jsonSchema.properties).map(([key, value]) => [
                        key,
                        jsonSchemaToGenAISchema(value),
                    ]));
                }
                if (Array.isArray(jsonSchema.required)) {
                    schema.required = jsonSchema.required;
                }
                break;
        }
    }
    if (typeof jsonSchema.description === 'string') {
        schema.description = jsonSchema.description;
    }
    if (Array.isArray(jsonSchema.enum)) {
        schema.enum = jsonSchema.enum.map((x) => String(x));
    }
    if ('default' in jsonSchema) {
        schema.default = jsonSchema.default;
    }
    if (Array.isArray(jsonSchema.examples) && jsonSchema.examples.length > 0) {
        schema.example = jsonSchema.examples[0];
    }
    if (Array.isArray(jsonSchema.anyOf)) {
        schema.anyOf = jsonSchema.anyOf.map((s) => jsonSchemaToGenAISchema(s));
    }
    else if (Array.isArray(jsonSchema.oneOf)) {
        schema.anyOf = jsonSchema.oneOf.map((s) => jsonSchemaToGenAISchema(s));
    }
    if (typeof jsonSchema.minimum === 'number') {
        schema.minimum = jsonSchema.minimum;
    }
    if (typeof jsonSchema.maximum === 'number') {
        schema.maximum = jsonSchema.maximum;
    }
    if (typeof jsonSchema.minLength === 'number') {
        schema.minLength = String(jsonSchema.minLength);
    }
    if (typeof jsonSchema.maxLength === 'number') {
        schema.maxLength = String(jsonSchema.maxLength);
    }
    if (typeof jsonSchema.pattern === 'string') {
        schema.pattern = jsonSchema.pattern;
    }
    return schema;
}
/**
 * Convert AI SDK Tool to GenAI FunctionDeclaration
 */
export function aiToolToGenAIFunction(tool) {
    // Extract the input schema - assume it's a Zod schema
    const inputSchema = tool.inputSchema;
    // Get the tool name from the schema or generate one
    let toolName = 'tool';
    let jsonSchema = {};
    if (inputSchema) {
        // Convert Zod schema to JSON Schema
        jsonSchema = toJSONSchema(inputSchema);
        // Extract name from Zod description if available
        const description = inputSchema.description;
        if (description) {
            const nameMatch = description.match(/name:\s*(\w+)/);
            if (nameMatch) {
                toolName = nameMatch[1] || '';
            }
        }
    }
    // Convert JSON Schema to GenAI Schema
    const genAISchema = jsonSchemaToGenAISchema(jsonSchema);
    // Create the FunctionDeclaration
    const functionDeclaration = {
        name: toolName,
        description: tool.description || jsonSchema.description || 'Tool function',
        parameters: genAISchema,
    };
    return functionDeclaration;
}
/**
 * Convert AI SDK Tool to GenAI CallableTool
 */
export function aiToolToCallableTool(tool, name) {
    const toolName = name || 'tool';
    return {
        name,
        async tool() {
            const functionDeclaration = aiToolToGenAIFunction(tool);
            if (name) {
                functionDeclaration.name = name;
            }
            return {
                functionDeclarations: [functionDeclaration],
            };
        },
        async callTool(functionCalls) {
            const parts = [];
            for (const functionCall of functionCalls) {
                // Check if this function call matches our tool
                if (functionCall.name !== toolName &&
                    name &&
                    functionCall.name !== name) {
                    continue;
                }
                // Execute the tool if it has an execute function
                if (tool.execute) {
                    try {
                        const args = isRecord(functionCall.args)
                            ? functionCall.args
                            : {};
                        const result = await tool.execute(args, {
                            toolCallId: functionCall.id || '',
                            messages: [],
                        });
                        // Convert the result to a Part
                        const part = {
                            functionResponse: {
                                id: functionCall.id,
                                name: functionCall.name || toolName,
                                response: {
                                    output: result,
                                },
                            },
                        };
                        parts.push(part);
                    }
                    catch (error) {
                        // Handle errors
                        const part = {
                            functionResponse: {
                                id: functionCall.id,
                                name: functionCall.name || toolName,
                                response: {
                                    error: error instanceof Error ? error.message : String(error),
                                },
                            },
                        };
                        parts.push(part);
                    }
                }
            }
            return parts;
        },
    };
}
export function extractSchemaFromTool(tool) {
    const inputSchema = tool.inputSchema;
    if (!inputSchema) {
        return {};
    }
    // Convert Zod schema to JSON Schema
    return toJSONSchema(inputSchema);
}
/**
 * Given an object of tools, creates an array of CallableTool
 */
export function callableToolsFromObject(tools) {
    return Object.entries(tools).map(([name, tool]) => aiToolToCallableTool(tool, name));
}

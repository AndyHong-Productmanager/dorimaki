// Model, default-model and command listings for the omo engine, shaped like
// opencode's provider.list / config.get / command.list responses.
// omo answers these per session, so they go through a hidden control session.

import os from 'node:os'

import { callControl, modelRefFromState, type OmoModelRef } from './sessions.js'

type Json = Record<string, any>

const CACHE_TTL_MS = 60_000

// omo extension commands that work over RPC and make sense in Discord. The
// rest are terminal helpers (/hooks, /keybindings, /diff, ...) or already
// have a dorimaki equivalent (/btw, /mcp). Kept short so skills still fit
// in Discord's 100 slash command limit.
const DISCORD_EXTENSION_COMMANDS = new Set([
  'goal',
  'loop',
  'handoff',
  'fast',
  'efforts',
  'reasoning',
  'fallback',
  'tasks',
  'task-kill',
  'todo',
  'remember',
  'memory',
  'search',
  'account',
  'agreements',
])

type ModelCatalog = {
  models: Json[]
  defaultModel: OmoModelRef | undefined
  fetchedAt: number
}

let catalog: ModelCatalog | null = null
let catalogPromise: Promise<ModelCatalog> | null = null

export function clearOmoCatalog(): void {
  catalog = null
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  if (catalog && Date.now() - catalog.fetchedAt < CACHE_TTL_MS) return catalog
  if (catalogPromise) return catalogPromise
  catalogPromise = (async () => {
    const { data, state } = await callControl(os.homedir(), 'get_available_models')
    const next: ModelCatalog = {
      models: Array.isArray(data?.models) ? data.models : [],
      defaultModel: modelRefFromState(state?.model),
      fetchedAt: Date.now(),
    }
    catalog = next
    return next
  })()
  try {
    return await catalogPromise
  } finally {
    catalogPromise = null
  }
}

export function getSupportedThinkingLevels(model: OmoModelRef): string[] {
  const entry = catalog?.models.find((m) => m.provider === model.provider && m.id === model.id)
  return Array.isArray(entry?.supportedThinkingLevels) ? entry.supportedThinkingLevels : []
}

function toOpencodeModel(model: Json): Json {
  const levels: string[] = Array.isArray(model.supportedThinkingLevels) ? model.supportedThinkingLevels : []
  return {
    id: model.id,
    providerID: model.provider,
    name: model.name ?? model.id,
    family: '',
    release_date: '',
    attachment: Array.isArray(model.input) && model.input.includes('image'),
    reasoning: model.reasoning === true,
    temperature: true,
    tool_call: true,
    limit: { context: model.contextWindow ?? 0, output: model.maxTokens ?? 0 },
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache_read: model.cost?.cacheRead ?? 0,
      cache_write: model.cost?.cacheWrite ?? 0,
    },
    options: {},
    status: 'active',
    variants: Object.fromEntries(levels.filter((level) => level !== 'off').map((level) => [level, {}])),
  }
}

export async function listProviders(): Promise<{ all: Json[]; connected: string[]; default: Record<string, string> }> {
  const { models, defaultModel } = await getModelCatalog()
  const providers = new Map<string, Json>()
  for (const model of models) {
    if (typeof model.provider !== 'string' || typeof model.id !== 'string') continue
    let provider = providers.get(model.provider)
    if (!provider) {
      provider = { id: model.provider, name: model.provider, source: 'api', env: [], options: {}, models: {} }
      providers.set(model.provider, provider)
    }
    provider.models[model.id] = toOpencodeModel(model)
  }

  const all = [...providers.values()]
  // Put omo's own default provider first so dorimaki's "first connected
  // provider" fallback matches what omo would pick.
  if (defaultModel) {
    all.sort((a, b) => Number(b.id === defaultModel.provider) - Number(a.id === defaultModel.provider))
  }
  const defaults: Record<string, string> = {}
  for (const provider of all) {
    const ids = Object.keys(provider.models)
    defaults[provider.id] = defaultModel?.provider === provider.id && provider.models[defaultModel.id]
      ? defaultModel.id
      : ids[0]!
  }
  return { all, connected: all.map((p) => p.id), default: defaults }
}

export async function getDefaultModelId(): Promise<string | undefined> {
  const { defaultModel } = await getModelCatalog()
  return defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : undefined
}

export async function listCommands(cwd: string): Promise<Json[]> {
  const { data } = await callControl(cwd || os.homedir(), 'get_commands')
  const commands: Json[] = Array.isArray(data?.commands) ? data.commands : []
  return commands
    .filter((command) => typeof command.name === 'string' && command.name)
    .filter((command) => {
      if (command.source === 'skill' || command.source === 'prompt') return true
      return command.source === 'extension' && DISCORD_EXTENSION_COMMANDS.has(command.name)
    })
    .map((command) => ({
      name: String(command.name).replace(/^skill:/, ''),
      description: typeof command.description === 'string' ? command.description : '',
      source: command.source === 'skill' ? 'skill' : 'config',
      template: '',
      hints: [],
    }))
}

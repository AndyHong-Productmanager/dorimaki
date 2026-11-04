// omo favorite models (settings.json `favoriteModels`), so dorimaki's /model
// picker can offer them first. Entries look like `provider/model` or
// `provider/model:thinkingLevel`. omo has no RPC for favorites, so the
// settings file in omo's agent directory is read directly.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getOmoServerInfo } from './server.js'

export type OmoFavoriteModel = {
  providerID: string
  modelID: string
  variant: string | undefined
}

export const FAVORITES_PROVIDER_VALUE = '__omo_favorites__'

function getAgentDir(): string {
  return getOmoServerInfo()?.agentDir ?? path.join(os.homedir(), '.omo', 'agent')
}

export function parseFavorite(entry: string): OmoFavoriteModel | undefined {
  const slash = entry.indexOf('/')
  if (slash <= 0) return undefined
  const providerID = entry.slice(0, slash)
  const rest = entry.slice(slash + 1)
  const colon = rest.lastIndexOf(':')
  const modelID = colon > 0 ? rest.slice(0, colon) : rest
  const variant = colon > 0 ? rest.slice(colon + 1) : undefined
  if (!modelID) return undefined
  return { providerID, modelID, variant: variant || undefined }
}

export function readOmoFavoriteModels(): OmoFavoriteModel[] {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(getAgentDir(), 'settings.json'), 'utf8'))
    const entries: unknown[] = Array.isArray(settings?.favoriteModels) ? settings.favoriteModels : []
    return entries
      .filter((entry): entry is string => typeof entry === 'string')
      .map(parseFavorite)
      .filter((favorite): favorite is OmoFavoriteModel => Boolean(favorite))
  } catch {
    return []
  }
}

/** Favorites whose provider is connected and still offers the model. */
export function getAvailableOmoFavorites(
  providers: Array<{ id: string; models?: Record<string, unknown> }>,
): OmoFavoriteModel[] {
  return readOmoFavoriteModels().filter((favorite) => {
    const provider = providers.find((p) => p.id === favorite.providerID)
    return Boolean(provider?.models?.[favorite.modelID])
  })
}

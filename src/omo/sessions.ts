// Session registry for the omo engine.
//
// dorimaki stores a stable session id per Discord thread (`ses_...`). Each id
// maps to an omo transcript at <dataDir>/omo-sessions/<id>.jsonl plus a small
// <id>.meta.json sidecar (cwd, created, title), because omo writes the
// transcript lazily and its routing handles (`rpc-N`) die with the host.
// Sessions are (re)opened on demand with `open_session { sessionPath }`.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getDataDir } from '../config.js'
import { createLogger, LogPrefix } from '../logger.js'
import { isDorimakiSessionId } from './ids.js'
import { OmoRpcError, type OmoRpcConnection } from './rpc.js'
import { getOmoConnection } from './server.js'

const logger = createLogger(LogPrefix.OPENCODE)

const OPEN_TIMEOUT_MS = 180_000

type Json = Record<string, any>

export type OmoSessionMeta = {
  id: string
  cwd: string
  created: number
  updated: number
  title: string
}

export type OmoModelRef = { provider: string; id: string }

export type LiveSession = {
  id: string
  handle: string
  cwd: string
  conn: OmoRpcConnection
  model: OmoModelRef | undefined
}

export function getOmoSessionsDir(): string {
  return path.join(getDataDir(), 'omo-sessions')
}

export function getSessionPath(id: string): string {
  return path.join(getOmoSessionsDir(), `${id}.jsonl`)
}

function getMetaPath(id: string): string {
  return path.join(getOmoSessionsDir(), `${id}.meta.json`)
}

export function readSessionMeta(id: string): OmoSessionMeta | null {
  if (!isDorimakiSessionId(id)) return null
  try {
    const meta = JSON.parse(fs.readFileSync(getMetaPath(id), 'utf8')) as OmoSessionMeta
    const updated = (() => {
      try {
        return fs.statSync(getSessionPath(id)).mtimeMs
      } catch {
        return meta.updated
      }
    })()
    return { ...meta, id, updated: Math.max(meta.updated ?? 0, Math.floor(updated)) }
  } catch {
    return null
  }
}

export function writeSessionMeta(meta: OmoSessionMeta): void {
  fs.mkdirSync(getOmoSessionsDir(), { recursive: true })
  fs.writeFileSync(getMetaPath(meta.id), JSON.stringify(meta, null, 2))
}

export function updateSessionTitle(id: string, title: string): OmoSessionMeta | null {
  const meta = readSessionMeta(id)
  if (!meta) return null
  const next = { ...meta, title, updated: Date.now() }
  writeSessionMeta(next)
  return next
}

export function listSessionMetas(): OmoSessionMeta[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(getOmoSessionsDir())
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => readSessionMeta(name.slice(0, -'.meta.json'.length)))
    .filter((meta): meta is OmoSessionMeta => Boolean(meta))
    .sort((a, b) => b.updated - a.updated)
}

export function deleteSessionFiles(id: string): void {
  for (const file of [getSessionPath(id), getMetaPath(id)]) {
    fs.rmSync(file, { force: true })
  }
}

// ── Live routing handles ──────────────────────────────────────

const live = new Map<string, LiveSession>()
const idByHandle = new Map<string, string>()
const opening = new Map<string, Promise<LiveSession | Error>>()

export function getLiveSession(id: string): LiveSession | undefined {
  const session = live.get(id)
  if (session && session.conn.isClosed) {
    forgetSession(id)
    return undefined
  }
  return session
}

export function sessionIdForHandle(handle: string | undefined): string | undefined {
  return handle ? idByHandle.get(handle) : undefined
}

export function forgetSession(id: string): void {
  const session = live.get(id)
  if (!session) return
  live.delete(id)
  if (idByHandle.get(session.handle) === id) idByHandle.delete(session.handle)
}

export function forgetHandle(handle: string): void {
  const id = idByHandle.get(handle)
  if (id) forgetSession(id)
}

export function forgetAllSessions(): string[] {
  const ids = [...live.keys()]
  live.clear()
  idByHandle.clear()
  return ids
}

export function setLiveModel(id: string, model: OmoModelRef | undefined): void {
  const session = live.get(id)
  if (session && model) session.model = model
}

export function modelRefFromState(model: Json | null | undefined): OmoModelRef | undefined {
  if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string') return undefined
  return { provider: model.provider, id: model.id }
}

/** Open (or attach to) the omo session for a dorimaki session id. */
export async function openSession({
  id,
  cwd,
  model,
}: {
  id: string
  cwd?: string
  model?: OmoModelRef
}): Promise<LiveSession | Error> {
  const existing = getLiveSession(id)
  if (existing) return existing
  const inFlight = opening.get(id)
  if (inFlight) return inFlight

  const promise = (async (): Promise<LiveSession | Error> => {
    const meta = readSessionMeta(id)
    const sessionCwd = meta?.cwd ?? cwd
    if (!sessionCwd) return new Error(`Session not found: ${id}`)
    const conn = await getOmoConnection()
    if (conn instanceof Error) return conn

    const sessionPath = getSessionPath(id)
    const isNew = !fs.existsSync(sessionPath)
    const data = await conn.call('open_session', {
      sessionPath,
      cwd: sessionCwd,
      auto_title: true,
      ...(isNew && model ? { provider: model.provider, modelId: model.id } : {}),
    }, { timeoutMs: OPEN_TIMEOUT_MS }).catch((e: Error) => e)
    if (data instanceof Error) return data

    const session: LiveSession = {
      id,
      handle: data.sessionId,
      cwd: sessionCwd,
      conn,
      model: modelRefFromState(data.state?.model),
    }
    live.set(id, session)
    idByHandle.set(session.handle, id)
    logger.log(`[OMO SESSIONS] opened ${id} as ${session.handle} (cwd ${sessionCwd})`)
    return session
  })()

  opening.set(id, promise)
  try {
    return await promise
  } finally {
    opening.delete(id)
  }
}

export async function createSession({
  cwd,
  model,
  id,
}: {
  cwd: string
  model?: OmoModelRef
  id: string
}): Promise<LiveSession | Error> {
  const now = Date.now()
  writeSessionMeta({ id, cwd, created: now, updated: now, title: '' })
  return openSession({ id, cwd, model })
}

function isStaleHandleError(error: unknown): boolean {
  if (!(error instanceof OmoRpcError)) return false
  return error.code === 'unknown_session' || error.code === 'session_closing'
}

/**
 * Run a session-scoped command, reopening the session once when the host has
 * evicted or forgotten its routing handle.
 */
export async function callSession(
  id: string,
  type: string,
  params: Json = {},
  options: { timeoutMs?: number } = {},
): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await openSession({ id })
    if (session instanceof Error) throw session
    try {
      return await session.conn.call(type, { ...params, sessionId: session.handle }, options)
    } catch (e) {
      if (attempt === 0 && isStaleHandleError(e)) {
        forgetSession(id)
        continue
      }
      throw e
    }
  }
  throw new Error(`omo ${type} failed for ${id}`)
}

// ── Control sessions ──────────────────────────────────────────
// Model and command listings are session-scoped in the RPC protocol, so a
// hidden `kind: "worker"` session per directory answers them.

const controlHandles = new Map<string, { conn: OmoRpcConnection; handle: string; state: Json }>()

export async function callControl(
  cwd: string,
  type: string,
  params: Json = {},
): Promise<{ data: any; state: Json }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const control = await openControl(cwd)
    try {
      const data = await control.conn.call(type, { ...params, sessionId: control.handle })
      return { data, state: control.state }
    } catch (e) {
      controlHandles.delete(cwd)
      if (attempt === 0 && isStaleHandleError(e)) continue
      throw e
    }
  }
  throw new Error(`omo ${type} failed`)
}

async function openControl(cwd: string): Promise<{ conn: OmoRpcConnection; handle: string; state: Json }> {
  const cached = controlHandles.get(cwd)
  if (cached && !cached.conn.isClosed) return cached
  const conn = await getOmoConnection()
  if (conn instanceof Error) throw conn
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  const controlDir = path.join(getOmoSessionsDir(), 'control')
  fs.mkdirSync(controlDir, { recursive: true })
  const data = await conn.call('open_session', {
    sessionPath: path.join(controlDir, `${hash}.jsonl`),
    cwd,
    kind: 'worker',
    auto_title: false,
  }, { timeoutMs: OPEN_TIMEOUT_MS })
  const control = { conn, handle: data.sessionId, state: data.state ?? {} }
  controlHandles.set(cwd, control)
  return control
}

export function forgetControlSessions(): void {
  controlHandles.clear()
}

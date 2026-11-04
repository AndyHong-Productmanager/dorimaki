// omo RPC host process manager.
// Mirrors the role of opencode.ts: ONE shared `omo --mode rpc --multi-session`
// process for all project directories. Each Discord thread maps to one omo
// session opened on that host with its own cwd.
//
// The host talks JSONL over stdio, so there is no port, token file or socket
// authentication to manage. Older omo builds exposed `omo app-server`; that
// command was removed in favour of this RPC mode.

import { spawn, type ChildProcess } from 'node:child_process'

import { createLogger, LogPrefix } from '../logger.js'
import { OmoRpcConnection } from './rpc.js'

const logger = createLogger(LogPrefix.OPENCODE)

const STARTUP_TIMEOUT_MS = 60_000

export type OmoServerInfo = {
  pid: number | null
  spawnedByUs: boolean
  serverVersion: string | undefined
  capabilities: string[]
  /** omo's agent directory (settings.json, auth.json), from get_protocol_info. */
  agentDir: string | undefined
}

type LifecycleEvent = { type: 'started'; port: number } | { type: 'stopped' }

let server: OmoServerInfo | null = null
let connection: OmoRpcConnection | null = null
let child: ChildProcess | null = null
let starting: Promise<OmoServerInfo | Error> | null = null
const lifecycleSubscribers = new Set<(e: LifecycleEvent) => void>()
const connectionSetupHooks = new Set<(conn: OmoRpcConnection) => Promise<void> | void>()

/** Run setup (event routing, client capabilities) on every new host before it is used. */
export function onOmoConnectionReady(hook: (conn: OmoRpcConnection) => Promise<void> | void): () => void {
  connectionSetupHooks.add(hook)
  return () => connectionSetupHooks.delete(hook)
}

export function subscribeOmoServerLifecycle(cb: (e: LifecycleEvent) => void): () => void {
  lifecycleSubscribers.add(cb)
  return () => lifecycleSubscribers.delete(cb)
}

function emit(event: LifecycleEvent): void {
  for (const cb of lifecycleSubscribers) cb(event)
}

export function getOmoBinary(): string {
  return process.env.DORIMAKI_OMO_BIN || 'omo'
}

export function getOmoHostArgs(): string[] {
  return ['--mode', 'rpc', '--multi-session', '--session-runtime', 'in-process']
}

export async function ensureOmoServer(): Promise<OmoServerInfo | Error> {
  if (server && connection && !connection.isClosed) return server
  if (starting) return starting

  starting = (async (): Promise<OmoServerInfo | Error> => {
    const bin = getOmoBinary()
    const args = getOmoHostArgs()
    logger.log(`[OMO SERVER] Spawning ${bin} ${args.join(' ')}`)

    // A stdio host has no per-connection identity, so client capabilities
    // come from the environment (senpi reads it under omo's OMO_ prefix).
    const clientCapabilities = 'question'
    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMO_RPC_CLIENT_CAPABILITIES: clientCapabilities,
        SENPI_RPC_CLIENT_CAPABILITIES: clientCapabilities,
      },
    })
    child = proc

    let stderrTail = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000)
      for (const line of chunk.split('\n')) {
        if (line.trim()) logger.log(`[OMO HOST] ${line.slice(0, 500)}`)
      }
    })

    const spawnError = await new Promise<Error | null>((resolve) => {
      proc.once('error', (err) => resolve(err))
      proc.once('spawn', () => resolve(null))
    })
    if (spawnError) {
      child = null
      return new Error(
        `Failed to start omo (${bin}): ${spawnError.message}. Install omo with: curl -fsSL https://get.omo.dev/install.sh | bash`,
      )
    }

    const conn = new OmoRpcConnection(proc)
    conn.onClose((reason) => {
      logger.warn(`[OMO SERVER] ${reason}`)
      if (connection === conn) {
        connection = null
        server = null
        child = null
        emit({ type: 'stopped' })
      }
    })

    const info = await conn.call('get_protocol_info', {}, { timeoutMs: STARTUP_TIMEOUT_MS })
      .catch((e: Error) => e)
    if (info instanceof Error) {
      try {
        proc.kill('SIGTERM')
      } catch {}
      return new Error(`omo rpc host did not start: ${info.message}. stderr: ${stderrTail.slice(-500)}`)
    }
    const capabilities: string[] = Array.isArray(info.capabilities) ? info.capabilities : []
    if (!capabilities.includes('multi_session')) {
      try {
        proc.kill('SIGTERM')
      } catch {}
      return new Error(
        `omo ${info.serverVersion ?? 'unknown'} does not support multi-session RPC. Update omo with: omo update`,
      )
    }

    for (const hook of connectionSetupHooks) {
      await Promise.resolve(hook(conn)).catch((e) => {
        logger.warn('[OMO SERVER] connection setup hook failed:', e)
      })
    }

    connection = conn
    server = {
      pid: proc.pid ?? null,
      spawnedByUs: true,
      serverVersion: info.serverVersion,
      capabilities,
      agentDir: typeof info.agentDir === 'string' ? info.agentDir : undefined,
    }
    emit({ type: 'started', port: 0 })
    logger.log(`[OMO SERVER] rpc host ready (engine ${info.serverVersion}, pid ${proc.pid})`)
    return server
  })()

  const result = await starting
  starting = null
  return result
}

/** Running host connection, starting the host when needed. */
export async function getOmoConnection(): Promise<OmoRpcConnection | Error> {
  const result = await ensureOmoServer()
  if (result instanceof Error) return result
  if (!connection) return new Error('omo rpc host is not running')
  return connection
}

export function getOmoServerInfo(): OmoServerInfo | null {
  return server
}

export async function stopOmoServer(): Promise<boolean> {
  const proc = child
  server = null
  connection = null
  child = null
  if (!proc || proc.exitCode !== null) return true
  emit({ type: 'stopped' })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {}
      resolve(true)
    }, 10_000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
    try {
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolve(true)
    }
  })
}

export async function restartOmoServer(): Promise<true | Error> {
  await stopOmoServer()
  const result = await ensureOmoServer()
  return result instanceof Error ? result : true
}

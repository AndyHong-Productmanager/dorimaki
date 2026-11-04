// JSONL client for an `omo --mode rpc --multi-session` host over stdio.
//
// Framing follows the senpi RPC contract: one JSON object per line, split on
// LF only (never Node readline, which also splits on U+2028/U+2029).
// Commands carry a client-owned `id`; the host answers with a
// `{type:"response", id, command, success, data|error}` record. Everything
// else on stdout is an event record, tagged with the routing `sessionId`.

import type { ChildProcess } from 'node:child_process'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.OPENCODE)

type Json = Record<string, any>

export type OmoRecord = Json & { type: string; sessionId?: string }

export class OmoRpcError extends Error {
  readonly code: string | undefined
  readonly data: unknown
  readonly command: string

  constructor({ command, message, code, data }: {
    command: string
    message: string
    code?: string
    data?: unknown
  }) {
    super(`omo ${command} failed: ${message}`)
    this.name = 'OmoRpcError'
    this.command = command
    this.code = code
    this.data = data
  }
}

type PendingCall = {
  command: string
  resolve: (data: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout | undefined
}

const DEFAULT_TIMEOUT_MS = 120_000

export class OmoRpcConnection {
  private nextId = 0
  private buffer = ''
  private closed = false
  private pending = new Map<string, PendingCall>()
  private recordHandlers = new Set<(record: OmoRecord) => void>()
  private closeHandlers = new Set<(reason: string) => void>()

  constructor(private proc: ChildProcess) {
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.handleChunk(chunk))
    proc.on('exit', (code, signal) => {
      this.handleClose(`omo rpc host exited (code=${code}, signal=${signal})`)
    })
    proc.stdin?.on('error', (err) => {
      this.handleClose(`omo rpc stdin error: ${err.message}`)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim()) this.handleLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let record: OmoRecord
    try {
      record = JSON.parse(line)
    } catch {
      logger.warn('[OMO RPC] non-JSON line:', line.slice(0, 200))
      return
    }
    if (!record || typeof record !== 'object') return

    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id)
      if (pending) {
        this.pending.delete(record.id)
        if (pending.timer) clearTimeout(pending.timer)
        if (record.success === false) {
          pending.reject(new OmoRpcError({
            command: record.command ?? pending.command,
            message: String(record.error ?? 'unknown error'),
            code: record.errorCode,
            data: record.errorData,
          }))
        } else {
          pending.resolve(record.data ?? {})
        }
        return
      }
    }

    for (const handler of this.recordHandlers) {
      try {
        handler(record)
      } catch (e) {
        logger.error('[OMO RPC] record handler threw:', e)
      }
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    const err = new Error(reason)
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
    for (const handler of this.closeHandlers) handler(reason)
  }

  /** Send one command and resolve with its `data`, or reject with OmoRpcError. */
  call(
    type: string,
    params: Json = {},
    { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<any> {
    if (this.closed || !this.proc.stdin?.writable) {
      return Promise.reject(new Error('omo rpc host is not running'))
    }
    const id = `dorimaki-${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`omo ${type} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : undefined
      this.pending.set(id, { command: type, resolve, reject, timer })
      this.proc.stdin!.write(`${JSON.stringify({ ...params, id, type })}\n`)
    })
  }

  /** Fire-and-forget command (no correlation). */
  send(type: string, params: Json = {}): void {
    if (this.closed || !this.proc.stdin?.writable) return
    this.proc.stdin.write(`${JSON.stringify({ ...params, type })}\n`)
  }

  onRecord(handler: (record: OmoRecord) => void): () => void {
    this.recordHandlers.add(handler)
    return () => this.recordHandlers.delete(handler)
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }
}

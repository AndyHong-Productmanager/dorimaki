// Low-level JSON-RPC 2.0 WebSocket client for the omo app-server
// (Codex app-server protocol). Handles outbound calls, inbound
// notifications, and inbound server-initiated requests (approvals,
// questions) which must be answered with a JSON-RPC result.

import { WebSocket } from 'ws'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.OPENCODE)

type Json = Record<string, any>

export type RpcNotification = { method: string; params: Json }
export type RpcServerRequest = {
  rpcId: number | string
  method: string
  params: Json
}

type PendingCall = {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

export class OmoRpcConnection {
  private ws: WebSocket | null = null
  private nextId = 0
  private pending = new Map<number, PendingCall>()
  private notificationHandlers = new Set<(n: RpcNotification) => void>()
  private requestHandlers = new Set<(r: RpcServerRequest) => Promise<any>>()
  private closeHandlers = new Set<() => void>()
  private connectPromise: Promise<void> | null = null

  constructor(
    private url: string,
    private token: string,
  ) {}

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
      })
      this.ws = ws
      ws.on('open', () => resolve())
      ws.on('error', (err) => {
        if (this.pending.size === 0 && !this.connectPromise) return
        reject(err instanceof Error ? err : new Error(String(err)))
      })
      ws.on('close', () => {
        this.ws = null
        this.connectPromise = null
        const err = new Error('omo app-server websocket closed')
        for (const p of this.pending.values()) p.reject(err)
        this.pending.clear()
        for (const h of this.closeHandlers) h()
      })
      ws.on('message', (data) => this.handleMessage(data.toString()))
    })
    return this.connectPromise
  }

  private handleMessage(raw: string): void {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      logger.warn('[OMO RPC] non-JSON frame:', raw.slice(0, 200))
      return
    }
    // Server-initiated request: has id AND method
    if (msg.id !== undefined && msg.method) {
      void this.handleServerRequest(msg)
      return
    }
    // Response to our call
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) {
        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    // Notification
    if (msg.method) {
      const n: RpcNotification = { method: msg.method, params: msg.params ?? {} }
      for (const h of this.notificationHandlers) h(n)
    }
  }

  private async handleServerRequest(msg: any): Promise<void> {
    const req: RpcServerRequest = { rpcId: msg.id, method: msg.method, params: msg.params ?? {} }
    let result: any = {}
    for (const h of this.requestHandlers) {
      try {
        const r = await h(req)
        if (r !== undefined) {
          result = r
          break
        }
      } catch (e) {
        logger.warn('[OMO RPC] server request handler error:', e)
      }
    }
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  }

  async call(method: string, params?: Json): Promise<any> {
    await this.connect()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
    })
  }

  onNotification(handler: (n: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** Register a handler for server-initiated requests. Return undefined to pass to next handler. */
  onServerRequest(handler: (r: RpcServerRequest) => Promise<any>): () => void {
    this.requestHandlers.add(handler)
    return () => this.requestHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    this.ws?.close()
    this.ws = null
    this.connectPromise = null
  }
}

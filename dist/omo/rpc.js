// JSONL client for an `omo --mode rpc --multi-session` host over stdio.
//
// Framing follows the senpi RPC contract: one JSON object per line, split on
// LF only (never Node readline, which also splits on U+2028/U+2029).
// Commands carry a client-owned `id`; the host answers with a
// `{type:"response", id, command, success, data|error}` record. Everything
// else on stdout is an event record, tagged with the routing `sessionId`.
import { createLogger, LogPrefix } from '../logger.js';
const logger = createLogger(LogPrefix.OPENCODE);
export class OmoRpcError extends Error {
    code;
    data;
    command;
    constructor({ command, message, code, data }) {
        super(`omo ${command} failed: ${message}`);
        this.name = 'OmoRpcError';
        this.command = command;
        this.code = code;
        this.data = data;
    }
}
const DEFAULT_TIMEOUT_MS = 120_000;
export class OmoRpcConnection {
    proc;
    nextId = 0;
    buffer = '';
    closed = false;
    pending = new Map();
    recordHandlers = new Set();
    closeHandlers = new Set();
    constructor(proc) {
        this.proc = proc;
        proc.stdout?.setEncoding('utf8');
        proc.stdout?.on('data', (chunk) => this.handleChunk(chunk));
        proc.on('exit', (code, signal) => {
            this.handleClose(`omo rpc host exited (code=${code}, signal=${signal})`);
        });
        proc.stdin?.on('error', (err) => {
            this.handleClose(`omo rpc stdin error: ${err.message}`);
        });
    }
    get isClosed() {
        return this.closed;
    }
    handleChunk(chunk) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            let line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.endsWith('\r'))
                line = line.slice(0, -1);
            if (line.trim())
                this.handleLine(line);
            newline = this.buffer.indexOf('\n');
        }
    }
    handleLine(line) {
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            logger.warn('[OMO RPC] non-JSON line:', line.slice(0, 200));
            return;
        }
        if (!record || typeof record !== 'object')
            return;
        if (record.type === 'response' && typeof record.id === 'string') {
            const pending = this.pending.get(record.id);
            if (pending) {
                this.pending.delete(record.id);
                if (pending.timer)
                    clearTimeout(pending.timer);
                if (record.success === false) {
                    pending.reject(new OmoRpcError({
                        command: record.command ?? pending.command,
                        message: String(record.error ?? 'unknown error'),
                        code: record.errorCode,
                        data: record.errorData,
                    }));
                }
                else {
                    pending.resolve(record.data ?? {});
                }
                return;
            }
        }
        for (const handler of this.recordHandlers) {
            try {
                handler(record);
            }
            catch (e) {
                logger.error('[OMO RPC] record handler threw:', e);
            }
        }
    }
    handleClose(reason) {
        if (this.closed)
            return;
        this.closed = true;
        const err = new Error(reason);
        for (const pending of this.pending.values()) {
            if (pending.timer)
                clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pending.clear();
        for (const handler of this.closeHandlers)
            handler(reason);
    }
    /** Send one command and resolve with its `data`, or reject with OmoRpcError. */
    call(type, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        if (this.closed || !this.proc.stdin?.writable) {
            return Promise.reject(new Error('omo rpc host is not running'));
        }
        const id = `dorimaki-${++this.nextId}`;
        return new Promise((resolve, reject) => {
            const timer = timeoutMs > 0
                ? setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`omo ${type} timed out after ${timeoutMs}ms`));
                }, timeoutMs)
                : undefined;
            this.pending.set(id, { command: type, resolve, reject, timer });
            this.proc.stdin.write(`${JSON.stringify({ ...params, id, type })}\n`);
        });
    }
    /** Fire-and-forget command (no correlation). */
    send(type, params = {}) {
        if (this.closed || !this.proc.stdin?.writable)
            return;
        this.proc.stdin.write(`${JSON.stringify({ ...params, type })}\n`);
    }
    onRecord(handler) {
        this.recordHandlers.add(handler);
        return () => this.recordHandlers.delete(handler);
    }
    onClose(handler) {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }
}

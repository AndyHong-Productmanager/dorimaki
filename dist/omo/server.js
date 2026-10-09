// omo app-server process manager.
// Mirrors the role of opencode.ts: ONE shared `omo app-server` process for
// all project directories; threads scope work per cwd.
//
// The app-server listens on a loopback websocket and requires a bearer token
// it writes to ~/.omo/agent/app-server/ws-token on startup.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createLogger, LogPrefix } from '../logger.js';
const logger = createLogger(LogPrefix.OPENCODE);
const DEFAULT_HOSTNAME = '127.0.0.1';
const TOKEN_PATH = path.join(os.homedir(), '.omo/agent/app-server/ws-token');
let server = null;
let child = null;
let starting = null;
const lifecycleSubscribers = new Set();
export function subscribeOmoServerLifecycle(cb) {
    lifecycleSubscribers.add(cb);
    return () => lifecycleSubscribers.delete(cb);
}
function emit(event) {
    for (const cb of lifecycleSubscribers)
        cb(event);
}
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, DEFAULT_HOSTNAME, () => {
            const address = srv.address();
            if (!address || typeof address === 'string') {
                srv.close();
                reject(new Error('Failed to allocate free port'));
                return;
            }
            srv.close(() => resolve(address.port));
        });
        srv.on('error', reject);
    });
}
function waitForReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const attempt = () => {
            const req = http.get({ host: DEFAULT_HOSTNAME, port, path: '/readyz', timeout: 1500 }, (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    resolve(true);
                }
                else {
                    retry();
                }
            });
            req.on('error', retry);
            req.on('timeout', () => {
                req.destroy();
                retry();
            });
        };
        const retry = () => {
            if (Date.now() > deadline) {
                resolve(false);
                return;
            }
            setTimeout(attempt, 250);
        };
        attempt();
    });
}
export function readOmoWsToken() {
    try {
        return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null;
    }
    catch {
        return null;
    }
}
export async function ensureOmoServer() {
    if (server)
        return server;
    if (starting)
        return starting;
    starting = (async () => {
        const port = await getFreePort();
        logger.log(`[OMO SERVER] Spawning omo app-server on ${DEFAULT_HOSTNAME}:${port}`);
        const proc = spawn('omo', ['app-server', '--listen', `ws://${DEFAULT_HOSTNAME}:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        child = proc;
        let stderrTail = '';
        proc.stderr?.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-4000);
        });
        proc.on('exit', (code) => {
            logger.warn(`[OMO SERVER] app-server exited with code ${code}`);
            if (server?.pid === proc.pid)
                server = null;
            child = null;
            emit({ type: 'stopped' });
        });
        const ready = await waitForReady(port, 30_000);
        if (!ready) {
            try {
                proc.kill('SIGTERM');
            }
            catch { }
            return new Error(`omo app-server did not become ready on port ${port}. stderr: ${stderrTail.slice(-500)}`);
        }
        const token = readOmoWsToken();
        if (!token) {
            return new Error('omo app-server ready but ws-token file missing');
        }
        server = { port, hostname: DEFAULT_HOSTNAME, pid: proc.pid ?? null, spawnedByUs: true };
        emit({ type: 'started', port });
        logger.log(`[OMO SERVER] app-server ready on port ${port} (pid ${proc.pid})`);
        return server;
    })();
    const result = await starting;
    starting = null;
    return result;
}
export function getOmoServerInfo() {
    return server;
}
export function getOmoServerWsUrl() {
    if (!server)
        return null;
    return `ws://${server.hostname}:${server.port}/`;
}
export async function stopOmoServer() {
    if (!child) {
        server = null;
        return true;
    }
    const proc = child;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch { }
            resolve(true);
        }, 5000);
        proc.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
        try {
            proc.kill('SIGTERM');
        }
        catch {
            clearTimeout(timer);
            resolve(true);
        }
        server = null;
        child = null;
    });
}
export async function restartOmoServer() {
    await stopOmoServer();
    const result = await ensureOmoServer();
    return result instanceof Error ? result : true;
}

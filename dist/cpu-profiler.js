// Live CPU profiling for the running Dorimaki process.
// Type `cpuprof` in the bot terminal to start. Type it again to stop,
// or wait 20s for auto-stop. Writes Chrome DevTools .cpuprofile files
// to <dataDir>/cpu-profiles/.
import * as errore from 'errore';
import fs from 'node:fs';
import inspector from 'node:inspector/promises';
import path from 'node:path';
import readline from 'node:readline';
import { getDataDir } from './config.js';
import { FilesystemOperationError } from './errors.js';
import { createLogger, LogPrefix } from './logger.js';
const logger = createLogger(LogPrefix.CPU);
export const CPU_PROF_AUTO_STOP_MS = 20_000;
class CpuProfilerError extends errore.createTaggedError({
    name: 'CpuProfilerError',
    message: '$reason',
}) {
}
let session = null;
let autoStopTimer = null;
let stdinReader = null;
let lock = Promise.resolve();
function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.then(() => { }, () => { });
    return run;
}
function getCpuProfileDir() {
    return path.join(getDataDir(), 'cpu-profiles');
}
function cpuProfilePath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(getCpuProfileDir(), `cpu-${timestamp}.cpuprofile`);
}
export function isCpuProfiling() {
    return session !== null;
}
export function parseStdinCommand(line) {
    if (line.trim().toLowerCase() === 'cpuprof')
        return 'cpuprof';
    return null;
}
function clearAutoStopTimer() {
    if (!autoStopTimer)
        return;
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
}
function scheduleAutoStop(autoStopMs) {
    clearAutoStopTimer();
    autoStopTimer = setTimeout(() => {
        autoStopTimer = null;
        void stopCpuProfiling().then((result) => {
            if (result instanceof Error) {
                logger.warn('CPU profile auto-stop failed:', result.message);
                return;
            }
            logger.log(`CPU profile auto-stopped: ${result.path}`);
        });
    }, autoStopMs);
    autoStopTimer.unref();
}
async function startUnlocked({ autoStopMs, }) {
    if (session) {
        return new CpuProfilerError({
            reason: 'CPU profiling is already running. Type cpuprof again to stop.',
        });
    }
    const next = new inspector.Session();
    const connected = errore.try(() => {
        next.connect();
    }, (e) => new CpuProfilerError({
        reason: 'Failed to connect inspector. Type cpuprof again after a few seconds.',
        cause: e,
    }));
    if (connected instanceof Error)
        return connected;
    const enabled = await next.post('Profiler.enable').catch((e) => new CpuProfilerError({
        reason: 'Failed to enable profiler',
        cause: e,
    }));
    if (enabled instanceof Error) {
        next.disconnect();
        return enabled;
    }
    const started = await next.post('Profiler.start').catch((e) => new CpuProfilerError({
        reason: 'Failed to start profiler',
        cause: e,
    }));
    if (started instanceof Error) {
        await next.post('Profiler.disable').catch((e) => {
            logger.warn('Failed to disable profiler after start error:', e);
        });
        next.disconnect();
        return started;
    }
    session = next;
    scheduleAutoStop(autoStopMs);
    logger.log(`CPU profiling started. Type cpuprof again to stop, or wait ${autoStopMs / 1000}s.`);
    return { action: 'started', autoStopMs };
}
async function stopUnlocked() {
    if (!session) {
        return new CpuProfilerError({
            reason: 'CPU profiling is not running. Type cpuprof to start.',
        });
    }
    const current = session;
    session = null;
    clearAutoStopTimer();
    const stopped = await current.post('Profiler.stop').catch((e) => new CpuProfilerError({
        reason: 'Failed to stop profiler',
        cause: e,
    }));
    await current.post('Profiler.disable').catch((e) => {
        logger.warn('Failed to disable profiler:', e);
    });
    current.disconnect();
    if (stopped instanceof Error)
        return stopped;
    const profile = stopped.profile;
    if (!profile) {
        return new CpuProfilerError({
            reason: 'Profiler stop returned no profile. Try cpuprof again.',
        });
    }
    const dir = getCpuProfileDir();
    const created = errore.try(() => {
        fs.mkdirSync(dir, { recursive: true });
    }, (e) => new FilesystemOperationError({
        operation: `mkdir ${dir}`,
        cause: e,
    }));
    if (created instanceof Error)
        return created;
    const filepath = cpuProfilePath();
    const written = await fs.promises
        .writeFile(filepath, JSON.stringify(profile))
        .catch((e) => new FilesystemOperationError({
        operation: `write ${filepath}`,
        cause: e,
    }));
    if (written instanceof Error)
        return written;
    logger.log(`CPU profile written: ${filepath}`);
    return { action: 'stopped', path: filepath };
}
export function startCpuProfiling({ autoStopMs = CPU_PROF_AUTO_STOP_MS, } = {}) {
    return withLock(() => startUnlocked({ autoStopMs }));
}
export function stopCpuProfiling() {
    return withLock(() => stopUnlocked());
}
export function toggleCpuProfiling({ autoStopMs = CPU_PROF_AUTO_STOP_MS, } = {}) {
    return withLock(async () => {
        if (session)
            return stopUnlocked();
        return startUnlocked({ autoStopMs });
    });
}
export function flushCpuProfiling() {
    return withLock(async () => {
        if (!session)
            return null;
        return stopUnlocked();
    });
}
export async function handleStdinLine(line, { autoStopMs = CPU_PROF_AUTO_STOP_MS, } = {}) {
    if (parseStdinCommand(line) !== 'cpuprof')
        return null;
    return toggleCpuProfiling({ autoStopMs });
}
export function startStdinCpuProfListener({ stdin, autoStopMs = CPU_PROF_AUTO_STOP_MS, } = {}) {
    if (stdinReader)
        return;
    const input = stdin ?? process.stdin;
    if (!stdin) {
        if (process.env.DORIMAKI_VITEST)
            return;
        if (!process.stdin.isTTY)
            return;
    }
    stdinReader = readline.createInterface({ input, terminal: false });
    stdinReader.on('line', (line) => {
        void handleStdinLine(line, { autoStopMs }).then((result) => {
            if (result instanceof Error)
                logger.warn(result.message);
        }, (error) => {
            logger.warn('CPU profile command failed:', error instanceof Error ? error.message : String(error));
        });
    });
    logger.log('Type cpuprof then Enter to capture a CPU profile');
}
export function stopStdinCpuProfListener() {
    if (!stdinReader)
        return;
    stdinReader.close();
    stdinReader = null;
}
export async function _resetCpuProfilerForTests() {
    stopStdinCpuProfListener();
    clearAutoStopTimer();
    await lock;
    if (!session)
        return;
    const stopped = await withLock(() => stopUnlocked());
    if (stopped instanceof Error) {
        logger.warn('Failed to reset CPU profiler:', stopped.message);
    }
}

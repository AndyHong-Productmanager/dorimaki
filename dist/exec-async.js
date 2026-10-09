import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const _execAsync = promisify(exec);
const _execFileAsync = promisify(execFile);
export function execAsync(command, options) {
    const timeoutMs = options?.timeout || DEFAULT_EXEC_TIMEOUT_MS;
    const childPromise = typeof command === 'string'
        ? _execAsync(command, options)
        : _execFileAsync(command.command, command.args, options);
    const execPromise = childPromise.then(({ stdout, stderr }) => {
        return {
            stdout: typeof stdout === 'string' ? stdout : stdout.toString(),
            stderr: typeof stderr === 'string' ? stderr : stderr.toString(),
        };
    });
    const commandLabel = typeof command === 'string'
        ? command
        : [command.command, ...command.args].join(' ');
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const pid = childPromise.child?.pid;
            if (pid) {
                try {
                    process.kill(-pid, 'SIGTERM');
                }
                catch {
                    childPromise.child?.kill('SIGTERM');
                }
            }
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${commandLabel}`));
        }, timeoutMs);
    });
    return Promise.race([execPromise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
    });
}

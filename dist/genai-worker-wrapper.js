// Main thread interface for the GenAI worker.
// Spawns and manages the worker thread, handling message passing for
// audio input/output, tool call completions, and graceful shutdown.
import { Worker } from 'node:worker_threads';
import { createLogger, LogPrefix } from './logger.js';
import { notifyError } from './sentry.js';
const genaiWorkerLogger = createLogger(LogPrefix.GENAI_WORKER);
const genaiWrapperLogger = createLogger(LogPrefix.GENAI_WORKER);
export function createGenAIWorker(options) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../dist/genai-worker.js', import.meta.url));
        // Handle messages from worker
        worker.on('message', (message) => {
            switch (message.type) {
                case 'assistantOpusPacket':
                    options.onAssistantOpusPacket(message.packet);
                    break;
                case 'assistantStartSpeaking':
                    options.onAssistantStartSpeaking?.();
                    break;
                case 'assistantStopSpeaking':
                    options.onAssistantStopSpeaking?.();
                    break;
                case 'assistantInterruptSpeaking':
                    options.onAssistantInterruptSpeaking?.();
                    break;
                case 'toolCallCompleted':
                    options.onToolCallCompleted?.(message);
                    break;
                case 'error':
                    genaiWorkerLogger.error('Error:', message.error);
                    options.onError?.(message.error);
                    break;
                case 'ready':
                    genaiWorkerLogger.log('Ready');
                    // Resolve with the worker interface
                    resolve({
                        sendRealtimeInput({ audio, audioStreamEnd }) {
                            worker.postMessage({
                                type: 'sendRealtimeInput',
                                audio,
                                audioStreamEnd,
                            });
                        },
                        sendTextInput(text) {
                            worker.postMessage({
                                type: 'sendTextInput',
                                text,
                            });
                        },
                        interrupt() {
                            worker.postMessage({
                                type: 'interrupt',
                            });
                        },
                        async stop() {
                            genaiWrapperLogger.log('Stopping worker...');
                            // Send stop message to trigger graceful shutdown
                            worker.postMessage({ type: 'stop' });
                            // Wait for worker to exit gracefully (with timeout)
                            await new Promise((resolve) => {
                                let resolved = false;
                                // Listen for worker exit
                                worker.once('exit', (code) => {
                                    if (!resolved) {
                                        resolved = true;
                                        genaiWrapperLogger.log(`[GENAI WORKER WRAPPER] Worker exited with code ${code}`);
                                        resolve();
                                    }
                                });
                                // Timeout after 5 seconds and force terminate
                                setTimeout(() => {
                                    if (!resolved) {
                                        resolved = true;
                                        genaiWrapperLogger.log('[GENAI WORKER WRAPPER] Worker did not exit gracefully, terminating...');
                                        void worker.terminate().then(() => {
                                            genaiWrapperLogger.log('Worker terminated');
                                            resolve();
                                        });
                                    }
                                }, 5000);
                            });
                        },
                    });
                    break;
            }
        });
        // Handle worker errors
        worker.on('error', (error) => {
            genaiWorkerLogger.error('Worker error:', error);
            reject(error);
        });
        worker.on('exit', (code) => {
            if (code !== 0) {
                genaiWorkerLogger.error(`Worker stopped with exit code ${code}`);
                void notifyError(new Error(`GenAI worker exited with code ${code}`), 'GenAI worker non-zero exit after init');
            }
        });
        // Send initialization message
        const initMessage = {
            type: 'init',
            directory: options.directory,
            systemMessage: options.systemMessage,
            guildId: options.guildId,
            channelId: options.channelId,
            appId: options.appId,
            geminiApiKey: options.geminiApiKey,
        };
        worker.postMessage(initMessage);
    });
}

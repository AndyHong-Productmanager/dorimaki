/**
 * Factory to create a Winston logger instance.
 * @param options Optional logger options.
 * @param options.level Log level (default: process.env.LOG_LEVEL or 'info')
 * @param options.transports Array of Winston transports (default: Console)
 * @returns winston.Logger
 *
 * Note: All logger methods accept either (message, metaObject) or (message, primitive/array),
 * where primitives/arrays are wrapped as { value: ... }.
 */
export declare function createLogger(options?: {
  level?: string;
  transports?: any[];
}): import('winston').Logger & {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  // ...other winston log levels if needed
};

/**
 * Default logger instance.
 *
 * All logger methods accept either (message, metaObject) or (message, primitive/array),
 * where primitives/arrays are wrapped as { value: ... }.
 */
export declare const log: import('winston').Logger & {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  // ...other winston log levels if needed
};
export default log;

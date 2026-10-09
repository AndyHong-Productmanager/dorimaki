import winston from 'winston';

/**
 * Factory to create a Winston logger instance.
 * @param {Object} [options]
 * @param {string} [options.level] - Log level (default: process.env.LOG_LEVEL or 'info')
 * @param {Array} [options.transports] - Array of Winston transports (default: Console)
 * @returns {winston.Logger}
 */
export const createLogger = ({
  level = process.env.LOG_LEVEL || 'info',
  transports = [new winston.transports.Console()]
} = {}) => {
  const logger = winston.createLogger({
    level,
    format: winston.format.printf(({ level, message, ...meta }) => {
      let msg = `[${level.toUpperCase()}] ${message}`;
      const metaKeys = Object.keys(meta).filter(k => k !== 'level' && k !== 'message');
      if (metaKeys.length > 0) {
        // Custom replacer to handle BigInt and circular references
        const seen = new WeakSet();
        const replacer = (key, value) => {
          if (typeof value === 'bigint') return value.toString() + 'n';
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        };
        msg += ' ' + JSON.stringify(Object.fromEntries(metaKeys.map(k => [k, meta[k]])), replacer);
      }
      return msg;
    }),
    transports
  });

  // Patch logger methods to support primitive/array as meta
  const levels = Object.keys(logger.levels || winston.config.npm.levels);
  levels.forEach((method) => {
    const orig = logger[method];
    logger[method] = function (msg, meta) {
      if (arguments.length === 2 && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
        return orig.call(this, msg, { value: meta });
      }
      return orig.apply(this, arguments);
    };
  });
  return logger;
};

const log = createLogger();
export default log;
export { log };

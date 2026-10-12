// Winston logger. Everything goes to stderr: stdout carries the JSON event lines.
import winston from 'winston';

export function makeLogger(label = 'bridge', level = process.env.BRIDGE_LOG_LEVEL || 'info') {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level: lvl, message, ...rest }) => {
        const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
        return `${timestamp} ${label} ${lvl}: ${message}${extra}`;
      }),
    ),
    transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] })],
  });
}

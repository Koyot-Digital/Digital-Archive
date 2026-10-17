import { pino, type LoggerOptions } from "pino";
import { config } from "../config.js";

/**
 * Structured logging with redaction.
 *
 * Anything that could carry a session cookie, an API key or an OAuth code is
 * redacted at the logger rather than at each call site, so a stray
 * `log.info({ req })` can never leak a credential into the homeserver logs.
 */
const redact = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['x-archive-signature']",
  "res.headers['set-cookie']",
  "*.password",
  "*.secret",
  "*.token",
  "*.clientSecret",
  "*.access_token",
  "*.refresh_token",
  "code",
];

export function buildLoggerOptions(service: string): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { service },
    redact: { paths: redact, censor: "[redacted]" },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.isDev
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  };
}

export const logger = pino(buildLoggerOptions("archive"));

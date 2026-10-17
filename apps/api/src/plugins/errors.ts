import fp from "fastify-plugin";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { config } from "../config.js";

/**
 * One error shape for the whole API:
 *
 *   { "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
 *
 * Clients branch on `code`, never on the message. 5xx messages are replaced
 * with a generic string so an internal failure cannot leak a connection
 * string or a file path to the public internet.
 */

function zodDetails(err: ZodError) {
  return err.issues.slice(0, 50).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export const errorsPlugin = fp(
  async (app) => {
    app.setErrorHandler((err, req, reply) => {
      const requestId = req.id;

      if (err instanceof ZodError) {
        reply.status(422);
        return reply.send({
          error: {
            code: "validation_failed",
            message: "Request failed validation",
            details: zodDetails(err),
            requestId,
          },
        });
      }

      if (err instanceof AppError) {
        if (err.statusCode >= 500) {
          req.log.error({ err, code: err.code }, "application error");
        } else {
          req.log.info({ code: err.code, msg: err.message }, "client error");
        }
        reply.status(err.statusCode);
        return reply.send({
          error: {
            code: err.code,
            message: err.expose ? err.message : "Internal server error",
            ...(err.expose && err.details !== undefined ? { details: err.details } : {}),
            requestId,
          },
        });
      }

      // Fastify's own errors (body too large, bad JSON, rate limit, ...).
      // Narrowing by class above leaves TS with `unknown` here, so re-type.
      const other = err as Error & { statusCode?: number; code?: string };
      const status = other.statusCode ?? 500;
      const fastifyCode = other.code;

      if (status >= 500) {
        req.log.error({ err: other }, "unhandled error");
        reply.status(500);
        return reply.send({
          error: {
            code: "internal_error",
            message: "Internal server error",
            requestId,
          },
        });
      }

      req.log.info({ err: other.message, fastifyCode }, "request rejected");
      reply.status(status);
      return reply.send({
        error: {
          code: fastifyCode ? fastifyCode.toLowerCase() : "bad_request",
          message: other.message,
          requestId,
        },
      });
    });

    app.setNotFoundHandler(
      {
        // A 404 probe loop should be rate limited like anything else.
        preHandler: app.hasDecorator("rateLimit")
          ? (app as unknown as { rateLimit: () => never }).rateLimit()
          : undefined,
      },
      (req, reply) => {
        reply.status(404);
        return reply.send({
          error: {
            code: "not_found",
            message: `Route ${req.method} ${req.url} does not exist`,
            requestId: req.id,
            ...(config.isDev ? { hint: `API is mounted at ${config.API_PREFIX}` } : {}),
          },
        });
      },
    );
  },
  { name: "archive-errors" },
);

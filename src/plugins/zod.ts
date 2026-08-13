import { STATUS_CODES } from "node:http";
import type {
  FastifyError,
  FastifyInstance,
  FastifySchemaCompiler,
  FastifyTypeProvider,
} from "fastify";
import { z, type ZodType } from "zod";

const STATUS_TEXT: Record<number, string | undefined> = STATUS_CODES;

/**
 * Makes Fastify validate with Zod instead of JSON Schema, and types
 * `request.body` / `request.params` from the schema.
 *
 * Validation must live in the pipeline, not in handlers: a handler-side
 * `Schema.parse()` throws an unhandled ZodError, which renders as a 500 with the
 * raw issue list as its message for what is a client error. Via the validator
 * compiler, Fastify rejects with 400 before the handler and `zodErrorHandler`
 * renders the issues.
 */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends ZodType
    ? z.output<this["schema"]>
    : unknown;
  serializer: this["schema"] extends ZodType
    ? z.input<this["schema"]>
    : unknown;
}

/**
 * try/catch is required by the Fastify docs: a compiler that throws instead of
 * returning `{ error }` escapes the request lifecycle.
 */
export const zodValidatorCompiler: FastifySchemaCompiler<ZodType> =
  ({ schema }) =>
  (data) => {
    try {
      const result = schema.safeParse(data);
      return result.success ? { value: result.data } : { error: result.error };
    } catch (error) {
      return { error: error as Error };
    }
  };

/** The subset of a validation failure safe to return to a caller. */
function issues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Single app-wide error handler.
 *
 * Request-schema failures map to 400 with the offending fields named. Only
 * errors Fastify tagged with `validationContext` qualify: a ZodError from
 * elsewhere — validating a model's reply, say — is a server-side failure and
 * must not be attributed to the caller.
 */
export function zodErrorHandler(app: FastifyInstance) {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const validationContext = (error as { validationContext?: string })
      .validationContext;
    if (error instanceof z.ZodError && validationContext) {
      request.log.info(
        {
          stage: "request.invalid",
          in: validationContext,
          issues: issues(error),
        },
        "request failed schema validation",
      );
      return reply.code(400).send({
        statusCode: 400,
        error: STATUS_TEXT[400],
        message: `${validationContext} failed validation`,
        issues: issues(error),
      });
    }
    const declared = error.statusCode ?? 0;
    const statusCode = declared >= 400 && declared <= 599 ? declared : 500;
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(statusCode).send({
      statusCode,
      error: STATUS_TEXT[statusCode] ?? "Error",
      // 5xx messages originate upstream and may carry provider text, so they
      // are replaced; 4xx messages are this service's own.
      message: statusCode >= 500 ? "Internal Server Error" : error.message,
    });
  });
}

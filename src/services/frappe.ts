import type { AppConfig } from "../config.js";

/** Header carrying the end-user identity through to the Frappe MCP tools. */
export const ACTOR_HEADER = "x-alpha-actor";

export type FrappeCallOptions = {
  /** End-user identity, sent as a header — never as a body field. */
  actor?: string;
  /** Extra transport headers, e.g. the MCP protocol revision. */
  headers?: Record<string, string>;
  /** Lets a caller's deadline cancel the call before its own timeout. */
  signal?: AbortSignal;
};

export interface FrappeClient {
  call<T>(
    method: string,
    body?: unknown,
    options?: FrappeCallOptions,
  ): Promise<T>;
}

/** Aborts on whichever expires first: the caller's deadline or this timeout. */
function callSignal(timeoutMs: number, signal?: AbortSignal) {
  const own = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, own]) : own;
}

export function createFrappeClient(
  config: Pick<
    AppConfig,
    "FRAPPE_URL" | "FRAPPE_AUTH_TOKEN" | "FRAPPE_TIMEOUT_MS"
  >,
): FrappeClient {
  return {
    async call<T>(method: string, body?: unknown, options?: FrappeCallOptions) {
      const response = await fetch(
        new URL(`/api/method/${method}`, config.FRAPPE_URL),
        {
          method: "POST",
          headers: {
            authorization: config.FRAPPE_AUTH_TOKEN,
            "content-type": "application/json",
            ...options?.headers,
            // Lets tools authorize against the real end user rather than the
            // shared service account FRAPPE_AUTH_TOKEN maps to.
            ...(options?.actor ? { [ACTOR_HEADER]: options.actor } : {}),
          },
          body: JSON.stringify(body ?? {}),
          signal: callSignal(config.FRAPPE_TIMEOUT_MS, options?.signal),
        },
      );
      if (!response.ok) {
        // The MCP endpoint returns JSON-RPC failures — parse error, unknown
        // method, bad params — as a 400 whose body names the reason; the status
        // line alone is "400 BAD REQUEST". Truncated because this reaches logs,
        // and callers that surface it keep only the status.
        const detail = await response.text().then(
          (body) => body.slice(0, 500).trim(),
          () => "",
        );
        throw new Error(
          `Frappe ${method} failed: ${response.status} ${response.statusText}${
            detail ? ` ${detail}` : ""
          }`,
        );
      }
      return (await response.json()) as T;
    },
  };
}

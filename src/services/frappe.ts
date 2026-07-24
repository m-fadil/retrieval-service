import type { AppConfig } from "../config.js";

/** Header carrying the end-user identity through to the Frappe MCP tools. */
export const ACTOR_HEADER = "x-alpha-actor";

export interface FrappeClient {
  call<T>(method: string, body?: unknown, actor?: string): Promise<T>;
}

export function createFrappeClient(
  config: Pick<
    AppConfig,
    "FRAPPE_URL" | "FRAPPE_AUTH_TOKEN" | "FRAPPE_TIMEOUT_MS"
  >,
): FrappeClient {
  return {
    async call<T>(method: string, body?: unknown, actor?: string) {
      const response = await fetch(
        new URL(`/api/method/${method}`, config.FRAPPE_URL),
        {
          method: "POST",
          headers: {
            authorization: config.FRAPPE_AUTH_TOKEN,
            "content-type": "application/json",
            // Propagated so tools can authorize against the real end user
            // rather than the shared service account this token maps to.
            ...(actor ? { [ACTOR_HEADER]: actor } : {}),
          },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(config.FRAPPE_TIMEOUT_MS),
        },
      );
      if (!response.ok)
        throw new Error(
          `Frappe ${method} failed: ${response.status} ${response.statusText}`,
        );
      return (await response.json()) as T;
    },
  };
}

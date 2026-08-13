import OpenAI from "openai";
import { openAiBaseURL, type AppConfig } from "../config.js";

/** Lets a caller's deadline cancel an in-flight embedding call. */
export type EmbedOptions = { signal?: AbortSignal };

export interface Embedder {
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
  /**
   * Embeds many texts in as few requests as the provider allows. Optional so a
   * test double can implement `embed` alone; `embedAll` falls back to it.
   */
  embedBatch?(texts: string[], options?: EmbedOptions): Promise<number[][]>;
}

/**
 * Embeds a list via `embedBatch` when available, else one `embed` per text.
 * Per-text embedding turns a few hundred FAQ entries into a few hundred
 * sequential round trips.
 */
export function embedAll(
  embedder: Embedder,
  texts: string[],
  options?: EmbedOptions,
): Promise<number[][]> {
  if (embedder.embedBatch) return embedder.embedBatch(texts, options);
  return Promise.all(texts.map((text) => embedder.embed(text, options)));
}

export function createOpenAiEmbedder(
  config: Pick<
    AppConfig,
    | "EMBEDDING_API_URL"
    | "EMBEDDING_API_KEY"
    | "EMBEDDING_MODEL"
    | "EMBEDDING_TIMEOUT_MS"
    | "EMBEDDING_MAX_RETRIES"
    | "EMBEDDING_BATCH_SIZE"
  >,
): Embedder {
  const client = new OpenAI({
    apiKey: config.EMBEDDING_API_KEY,
    baseURL: openAiBaseURL(config.EMBEDDING_API_URL),
    timeout: config.EMBEDDING_TIMEOUT_MS,
    maxRetries: config.EMBEDDING_MAX_RETRIES,
  });

  async function embedChunk(texts: string[], options?: EmbedOptions) {
    const response = await client.embeddings.create(
      {
        model: config.EMBEDDING_MODEL,
        input: texts,
        // Unset, the SDK requests base64, which some providers (Nvidia via
        // OpenRouter) reject with an error body the SDK does not throw on.
        encoding_format: "float",
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
    // Response order is not guaranteed by the API, so `index` maps each vector
    // back to its text.
    const vectors: number[][] = [];
    for (const [position, item] of (response.data ?? []).entries()) {
      const at = typeof item.index === "number" ? item.index : position;
      if (item.embedding?.length) vectors[at] = item.embedding;
    }
    if (vectors.length !== texts.length || vectors.some((v) => !v?.length)) {
      throw new Error(
        `Embedding response covered ${vectors.filter(Boolean).length} of ${texts.length} inputs`,
      );
    }
    return vectors;
  }

  return {
    async embed(text, options) {
      const [vector] = await embedChunk([text], options);
      if (!vector?.length)
        throw new Error("Embedding response did not include a vector");
      return vector;
    },
    async embedBatch(texts, options) {
      const vectors: number[][] = [];
      for (let at = 0; at < texts.length; at += config.EMBEDDING_BATCH_SIZE) {
        vectors.push(
          ...(await embedChunk(
            texts.slice(at, at + config.EMBEDDING_BATCH_SIZE),
            options,
          )),
        );
      }
      return vectors;
    },
  };
}

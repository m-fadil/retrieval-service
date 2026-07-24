import OpenAI from "openai";
import { openAiBaseURL, type AppConfig } from "../config.js";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export function createOpenAiEmbedder(
  config: Pick<
    AppConfig,
    | "EMBEDDING_API_URL"
    | "EMBEDDING_API_KEY"
    | "EMBEDDING_MODEL"
    | "EMBEDDING_TIMEOUT_MS"
  >,
): Embedder {
  const client = new OpenAI({
    apiKey: config.EMBEDDING_API_KEY,
    baseURL: openAiBaseURL(config.EMBEDDING_API_URL),
    timeout: config.EMBEDDING_TIMEOUT_MS,
  });
  return {
    async embed(text: string) {
      const response = await client.embeddings.create({
        model: config.EMBEDDING_MODEL,
        input: text,
        // Left unset, the SDK silently requests base64 and some providers
        // (e.g. Nvidia via OpenRouter) reject that with an error body the
        // SDK does not surface as a thrown error.
        encoding_format: "float",
      });
      const vector = response.data?.[0]?.embedding;
      if (!vector?.length)
        throw new Error("Embedding response did not include a vector");
      return vector;
    },
  };
}

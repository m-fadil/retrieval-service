import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../config.js";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export function createGeminiEmbedder(
  config: Pick<
    AppConfig,
    "EMBEDDING_API_KEY" | "EMBEDDING_MODEL" | "EMBEDDING_TIMEOUT_MS"
  >,
): Embedder {
  const ai = new GoogleGenAI({ apiKey: config.EMBEDDING_API_KEY });
  return {
    async embed(text: string) {
      const response = await ai.models.embedContent({
        model: config.EMBEDDING_MODEL,
        contents: text,
        config: { httpOptions: { timeout: config.EMBEDDING_TIMEOUT_MS } },
      });
      const vector = response.embeddings?.[0]?.values;
      if (!vector?.length)
        throw new Error("Gemini embedding response did not include a vector");
      return vector;
    },
  };
}

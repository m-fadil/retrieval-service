import type { AppConfig } from "../config.js";
import { createChatFlow, type Retrieve } from "../chat/orchestrator.js";
import type { ChatLog } from "../chat/log.js";
import { documentAnswerPrompt } from "../chat/prompts.js";
import type { Embedder } from "./embeddings.js";
import { embedAll } from "./embeddings.js";
import { createFaqGenerator } from "./faq-generate.js";
import { createLlm, type Llm } from "./llm.js";
import { createFrappeMcpClient, type FrappeMcpClient } from "./mcp.js";
import type { VectorStore, SearchHit } from "./qdrant.js";
import type { FaqGenerateRequest, FaqGenerateResult } from "../schemas/faq.js";
import type {
  AnswerRequest,
  ChatRequest,
  ChatResponse,
  IndexRequest,
  QueryRequest,
  SearchRequest,
} from "../schemas/query.js";

export { ChatFailedError, ChatDeadlineError } from "../chat/log.js";
export type { ChatLog } from "../chat/log.js";

/**
 * The service behind every route: a write path turning documents into vectors, a
 * read path answering questions from them, and the chat flow, which lives in
 * ../chat.
 */
export interface RagService {
  index(input: IndexRequest): Promise<{ indexed: number }>;
  search(input: SearchRequest): Promise<{ matches: SearchHit[] }>;
  answer(input: AnswerRequest, log?: ChatLog): Promise<ChatResponse<SearchHit>>;
  query(input: QueryRequest): Promise<ChatResponse<SearchHit>>;
  chat(input: ChatRequest, log?: ChatLog): Promise<ChatResponse<SearchHit>>;
  generateFaq(
    input: FaqGenerateRequest,
    log?: ChatLog,
  ): Promise<FaqGenerateResult>;
}

type AnswerComposer = (
  question: string,
  sources: SearchHit[],
  log?: ChatLog,
) => Promise<string>;

export function createRagService(
  config: AppConfig,
  embedder: Embedder,
  store: VectorStore,
  mcp: FrappeMcpClient = createFrappeMcpClient(config),
  composeAnswerOverride?: AnswerComposer,
  llm: Llm = createLlm(config),
): RagService {
  const retrieve: Retrieve = async (question, limit, options) => {
    const vector = await embedder.embed(question, { signal: options.signal });
    return store.search(
      vector,
      limit,
      options.source ? { source: options.source } : undefined,
    );
  };

  const chat = createChatFlow({ config, llm, mcp, retrieve });
  const generateFaq = createFaqGenerator(llm);

  function filterMatches(sources: SearchHit[], minScore: number) {
    return sources.filter(
      (hit) => hit.score === undefined || hit.score >= minScore,
    );
  }

  const composeAnswer: AnswerComposer =
    composeAnswerOverride ??
    async function composeLlmAnswer(question, sources, log) {
      const context = sources
        .map(
          (hit, index) => `[${index + 1}] ${String(hit.payload?.text ?? "")}`,
        )
        .filter((line) => line.trim().length > 4)
        .join("\n");
      return llm.complete(documentAnswerPrompt(question, context), {
        stage: "answer.compose",
        log,
      });
    };

  async function answer(
    input: AnswerRequest,
    log?: ChatLog,
  ): Promise<ChatResponse<SearchHit>> {
    const sources = await retrieve(input.question, input.limit, {});
    return {
      answer: await composeAnswer(input.question, sources, log),
      route: "hybrid",
      needs_admin: false,
      reason: "tool_match",
      sources,
    };
  }

  return {
    async index(input) {
      // One embeddings request per batch, not per document: the provider accepts
      // an array, so per-document calls mean a few hundred round trips.
      const vectors = await embedAll(
        embedder,
        input.documents.map((doc) => doc.text),
      );
      const points = input.documents.map((doc, at) => ({
        id: doc.id,
        vector: vectors[at]!,
        payload: {
          text: doc.text,
          source: doc.source ?? doc.id,
          ...doc.metadata,
        },
      }));
      await store.upsert(points);
      return { indexed: points.length };
    },
    async search(input) {
      const sources = await retrieve(input.question, input.limit, {
        ...(input.source ? { source: input.source } : {}),
      });
      return { matches: filterMatches(sources, input.min_score) };
    },
    answer,
    query: answer,
    chat,
    generateFaq,
  };
}

/**
 * Mock AI provider for multi-pod scenarios.
 *
 * Two surfaces:
 *
 *   1. OpenAI-compatible (`/v1/...`) — mesh's `openai-compatible` adapter
 *      wraps `@ai-sdk/openai` against a custom baseURL, so pointing a
 *      credential's JSON at this server is enough to drive the full
 *      decopilot dispatch pipeline (streamText → onChunk → JetStream
 *      pump → /stream tail) without burning real LLM budget.
 *
 *      GET  /v1/models                — required by listModels() at tier
 *                                       resolution time
 *      POST /v1/chat/completions      — SSE stream of OpenAI-shaped chunks
 *
 *   2. Gemini Interactions API (`/v1beta/interactions`) — the async path
 *      mesh uses for Gemini Deep Research models (web_search tool). The
 *      adapter at `apps/mesh/src/ai-providers/adapters/gemini-interactions.ts`
 *      points at this URL when `GEMINI_INTERACTIONS_URL` is set.
 *
 *      POST /v1beta/interactions      — accept a job, return `{ id }`
 *      GET  /v1beta/interactions/:id  — poll; returns in_progress until
 *                                       a configurable number of polls
 *                                       pass, then `completed` (or
 *                                       `failed` on hint).
 *
 * Test-time control comes from the user message text / interaction
 * `input` field — mesh doesn't propagate request headers to outbound
 * provider calls, so we encode hints in the prompt instead. Recognized
 * forms:
 *
 *   "slow:<chunks>x<delayMs>"      — e.g. "slow:5x500"
 *   "many:<chunks>"                — e.g. "many:20"
 *   "interactions:polls=<N>"       — return in_progress for N polls,
 *                                    then completed (default: 2)
 *   "interactions:fail"            — return `failed` on the first poll
 *   "interactions:text=<text>"     — completed-state report text
 *                                    (URL-encoded; default: stock summary)
 *
 * Falls back to fast defaults so happy-path scenarios run quickly.
 */

const PORT = Number(process.env.PORT ?? 9000);
const MODEL_ID = "mock-model";

interface DeltaChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: "assistant"; content?: string };
    finish_reason: null | "stop";
  }>;
}

function frame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function done(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

function buildChunk(
  id: string,
  delta: DeltaChunk["choices"][0]["delta"],
  finish: DeltaChunk["choices"][0]["finish_reason"] = null,
): DeltaChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

type ContentPart = { type?: string; text?: string };
interface CompletionsBody {
  messages?: Array<{ role: string; content?: string | ContentPart[] }>;
}

/** Flatten OpenAI content (string OR parts array) into plain text. */
function contentToText(content: string | ContentPart[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ");
}

/**
 * Walk the message array bottom-up looking for a control hint in the
 * latest user turn. Returns {chunks, delayMs} — defaults applied for
 * unspecified fields.
 */
function parseHints(body: CompletionsBody): {
  chunks: number;
  delayMs: number;
} {
  const last = body.messages
    ?.slice()
    .reverse()
    .find((m) => m.role === "user");
  const text = contentToText(last?.content);
  if (!text) {
    return { chunks: 5, delayMs: 50 };
  }
  const slow = text.match(/slow:(\d+)x(\d+)/);
  if (slow)
    return {
      chunks: Math.max(1, Number(slow[1])),
      delayMs: Math.max(0, Number(slow[2])),
    };
  const many = text.match(/many:(\d+)/);
  if (many) return { chunks: Math.max(1, Number(many[1])), delayMs: 50 };
  return { chunks: 5, delayMs: 50 };
}

async function streamCompletion(req: Request): Promise<Response> {
  const reqBody = (await req.json().catch(() => ({}))) as CompletionsBody;
  const { chunks: numChunks, delayMs } = parseHints(reqBody);
  const id = `chatcmpl-${crypto.randomUUID()}`;

  const stream = new ReadableStream({
    async start(controller) {
      // OpenAI starts every stream with a role frame; the AI SDK relies on
      // it to attribute subsequent deltas to "assistant".
      controller.enqueue(frame(buildChunk(id, { role: "assistant" })));

      for (let i = 0; i < numChunks; i++) {
        if (delayMs > 0) await Bun.sleep(delayMs);
        controller.enqueue(
          frame(buildChunk(id, { content: `chunk-${i + 1} ` })),
        );
      }

      controller.enqueue(frame(buildChunk(id, {}, "stop")));
      controller.enqueue(done());
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ============================================================================
// Gemini Interactions API mock
// ============================================================================

/**
 * In-memory state for each submitted interaction. The mesh side persists
 * the `id` in `async_research_jobs` and polls until terminal, so the
 * mock only needs to keep the contract — no durability across restarts.
 */
interface InteractionState {
  /** Polls remaining before this job transitions to terminal. */
  pollsLeft: number;
  /** Terminal status to return once pollsLeft reaches 0. */
  terminal: "completed" | "failed";
  /** Final report text returned on `completed`. */
  text: string;
  /** Failure message returned on `failed`. */
  failMessage: string;
}

const interactions = new Map<string, InteractionState>();

const DEFAULT_REPORT =
  "Mock research report. The mock-ai server returned this body in lieu of " +
  "a real Gemini Deep Research interaction.";

function parseInteractionHints(input: string): {
  pollsLeft: number;
  terminal: "completed" | "failed";
  text: string;
} {
  const fail = /interactions:fail/.test(input);
  const pollsMatch = input.match(/interactions:polls=(\d+)/);
  const textMatch = input.match(/interactions:text=([^\s]+)/);
  return {
    pollsLeft: pollsMatch ? Math.max(0, Number(pollsMatch[1])) : 2,
    terminal: fail ? "failed" : "completed",
    text: textMatch ? decodeURIComponent(textMatch[1]) : DEFAULT_REPORT,
  };
}

async function submitInteraction(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    input?: string;
    agent?: string;
  };
  const id = `int_mock_${crypto.randomUUID()}`;
  const hints = parseInteractionHints(body.input ?? "");
  interactions.set(id, {
    pollsLeft: hints.pollsLeft,
    terminal: hints.terminal,
    text: hints.text,
    failMessage: "mock-ai: forced failure via interactions:fail hint",
  });
  return Response.json({ id });
}

function pollInteraction(id: string): Response {
  const state = interactions.get(id);
  if (!state) {
    return new Response(`Not found: interaction ${id}`, { status: 404 });
  }

  if (state.pollsLeft > 0) {
    state.pollsLeft -= 1;
    return Response.json({
      id,
      status: "in_progress",
      outputs: [
        {
          type: "thought_summary",
          text: `Working on it... (${state.pollsLeft} polls remaining)`,
          annotations: [],
        },
      ],
    });
  }

  // Terminal. Don't delete the row — production callers may poll again
  // after seeing terminal state (e.g. resume path that races a sweeper).
  if (state.terminal === "failed") {
    return Response.json({
      id,
      status: "failed",
      error: state.failMessage,
      outputs: [],
    });
  }

  return Response.json({
    id,
    status: "completed",
    outputs: [
      {
        type: "text",
        text: state.text,
        annotations: [
          {
            type: "url_citation",
            url: "https://example.test/mock-citation",
            title: "Mock citation",
          },
        ],
      },
    ],
    usage: {
      input_tokens: 42,
      output_tokens: 128,
    },
  });
}

// ============================================================================
// Dispatch
// ============================================================================

const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return new Response("ok");
  }

  if (path === "/v1/models" && req.method === "GET") {
    return Response.json({
      object: "list",
      data: [
        {
          id: MODEL_ID,
          object: "model",
          created: 0,
          owned_by: "mock",
        },
      ],
    });
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    return streamCompletion(req);
  }

  // Gemini Interactions API — submit + poll.
  if (path === "/v1beta/interactions" && req.method === "POST") {
    return submitInteraction(req);
  }
  if (path.startsWith("/v1beta/interactions/") && req.method === "GET") {
    const id = decodeURIComponent(path.slice("/v1beta/interactions/".length));
    return pollInteraction(id);
  }

  return new Response(`Not found: ${req.method} ${path}`, { status: 404 });
};

Bun.serve({ port: PORT, fetch: handler });
console.log(`[mock-ai] listening on :${PORT}`);

/**
 * Mock OpenAI-compatible AI provider for multi-pod scenarios.
 *
 * Mesh's `openai-compatible` adapter (apps/mesh/src/ai-providers/adapters/
 * openai-compatible.ts) wraps `@ai-sdk/openai` against a custom baseURL,
 * so pointing a credential's JSON at this server is enough to drive the
 * full decopilot dispatch pipeline (streamText → onChunk → JetStream pump
 * → /attach tail) without burning real LLM budget.
 *
 * Two endpoints:
 *   GET  /v1/models                — required by the adapter's listModels()
 *                                    call during tier resolution
 *   POST /v1/chat/completions      — SSE stream of OpenAI-shaped chunks
 *
 * Test-time control comes from the user message text — mesh doesn't
 * propagate request headers to outbound provider calls, so we encode
 * hints in the prompt instead. Recognized form:
 *
 *   "slow:<chunks>x<delayMs>"   — e.g. "slow:5x500" → 5 chunks, 500ms apart
 *   "many:<chunks>"             — e.g. "many:20"    → 20 chunks at default 50ms
 *
 * Falls back to a fast default (5 chunks × 50ms ≈ 250ms total) so
 * happy-path scenarios run quickly. Failure-injection scenarios opt
 * into longer runs by sending the hint in their user message.
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

  return new Response(`Not found: ${req.method} ${path}`, { status: 404 });
};

Bun.serve({ port: PORT, fetch: handler });
console.log(`[mock-ai] listening on :${PORT}`);

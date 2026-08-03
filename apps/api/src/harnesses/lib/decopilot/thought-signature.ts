/**
 * thought-signature — normalize Gemini thought signatures that OpenAI-format
 * gateways smuggle inside the tool-call id.
 *
 * Gemini-thinking models attach an opaque `thoughtSignature` to every function
 * call and require it echoed back on later turns (HTTP 400 otherwise). The
 * native Google provider carries it cleanly in
 * `providerMetadata.google.thoughtSignature` with a small id. But the OpenAI
 * chat-completions wire format has no field for it, so OpenAI-compatible
 * gateways (LiteLLM, and any gateway fronting Gemini over that format) pack it
 * into the one string every OpenAI client round-trips — the tool-call id —
 * as `call_<base>__thought__<signature>`. That bloats the id to multiple KB and
 * leaks into our conversation, UI, and DB (where it broke a Postgres btree key).
 *
 * This middleware makes the gateway path look exactly like the native Google
 * path: on the way IN it splits the id, keeps `call_<base>`, and stashes the
 * signature in `providerMetadata.google.thoughtSignature` (the same shape the
 * Google provider emits, which `conversation.ts` already preserves across
 * turns). On the way OUT it re-embeds `__thought__<signature>` back into the id
 * so the gateway can extract it for Gemini.
 *
 * Portable: imports only AI-SDK types, with no `@/*` or StudioContext coupling.
 */

import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  SharedV3ProviderMetadata,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";

/**
 * Separator LiteLLM (and compatible gateways) use to append the Gemini thought
 * signature to a tool-call id: `call_<base>__thought__<signature>`.
 * See https://github.com/BerriAI/litellm/pull/18374.
 */
const THOUGHT_SIGNATURE_SEPARATOR = "__thought__";

/**
 * Split a (possibly gateway-bloated) tool-call id into its base id and the
 * embedded signature. `signature` is null for normal ids — the common case and
 * a strict no-op for every non-Gemini provider.
 */
export function splitThoughtSignature(toolCallId: string): {
  baseId: string;
  signature: string | null;
} {
  const idx = toolCallId.indexOf(THOUGHT_SIGNATURE_SEPARATOR);
  if (idx === -1) return { baseId: toolCallId, signature: null };
  return {
    baseId: toolCallId.slice(0, idx),
    signature: toolCallId.slice(idx + THOUGHT_SIGNATURE_SEPARATOR.length),
  };
}

/** Re-attach a signature to a base id in the gateway's `__thought__` form. */
export function joinThoughtSignature(
  baseId: string,
  signature: string,
): string {
  return `${baseId}${THOUGHT_SIGNATURE_SEPARATOR}${signature}`;
}

function withGoogleSignature(
  existing: SharedV3ProviderMetadata | undefined,
  signature: string,
): SharedV3ProviderMetadata {
  return {
    ...existing,
    google: { ...(existing?.google ?? {}), thoughtSignature: signature },
  };
}

function readThoughtSignature(
  opts: SharedV3ProviderOptions | undefined,
): string | null {
  const v = opts?.google?.thoughtSignature;
  return typeof v === "string" ? v : null;
}

/** Strip an embedded signature off a tool-call object (stream or content). */
function stripToolCall<
  T extends { toolCallId: string; providerMetadata?: SharedV3ProviderMetadata },
>(part: T): T {
  const { baseId, signature } = splitThoughtSignature(part.toolCallId);
  if (signature === null) return part;
  return {
    ...part,
    toolCallId: baseId,
    providerMetadata: withGoogleSignature(part.providerMetadata, signature),
  };
}

function stripStreamPart(
  part: LanguageModelV3StreamPart,
): LanguageModelV3StreamPart {
  switch (part.type) {
    // The id arrives bloated on the streaming input parts too; rewrite it so
    // the reader correlates them with the (rewritten) final tool-call.
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end": {
      const { baseId, signature } = splitThoughtSignature(part.id);
      return signature === null ? part : { ...part, id: baseId };
    }
    case "tool-call":
      return stripToolCall(part);
    default:
      return part;
  }
}

/**
 * Outbound: re-embed each stored signature back into its tool-call id (and the
 * matching tool-result id — OpenAI format requires the pair to be equal). No-op
 * unless some assistant tool-call carries a signature.
 */
function reembedPrompt(
  params: LanguageModelV3CallOptions,
): LanguageModelV3CallOptions {
  const signatureByBaseId = new Map<string, string>();
  for (const message of params.prompt) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      const signature = readThoughtSignature(part.providerOptions);
      if (signature) signatureByBaseId.set(part.toolCallId, signature);
    }
  }
  if (signatureByBaseId.size === 0) return params;

  const prompt = params.prompt.map((message) => {
    if (message.role !== "assistant" && message.role !== "tool") return message;
    const content = message.content.map((part) => {
      if (part.type !== "tool-call" && part.type !== "tool-result") return part;
      const signature = signatureByBaseId.get(part.toolCallId);
      return signature
        ? {
            ...part,
            toolCallId: joinThoughtSignature(part.toolCallId, signature),
          }
        : part;
    });
    return { ...message, content } as typeof message;
  });
  return { ...params, prompt };
}

/**
 * Middleware that decodes Gemini thought signatures embedded in tool-call ids.
 * Apply only to OpenAI-format gateways (see `createLanguageModel`); it is a
 * no-op for any id without the `__thought__` separator.
 */
export function thoughtSignatureMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => reembedPrompt(params),
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<
            LanguageModelV3StreamPart,
            LanguageModelV3StreamPart
          >({
            transform(part, controller) {
              controller.enqueue(stripStreamPart(part));
            },
          }),
        ),
      };
    },
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      const content = result.content.map(
        (part: LanguageModelV3Content): LanguageModelV3Content =>
          part.type === "tool-call" ? stripToolCall(part) : part,
      );
      return { ...result, content };
    },
  };
}

/** Wrap a model so embedded thought signatures are decoded in/out. */
export function withThoughtSignatureCodec(
  model: LanguageModelV3,
): LanguageModelV3 {
  return wrapLanguageModel({ model, middleware: thoughtSignatureMiddleware() });
}

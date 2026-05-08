/**
 * Gemini Interactions API client for Deep Research models.
 *
 * Deep Research models (deep-research-preview-04-2026, etc.) cannot be reached
 * through `generateContent` / `streamText`. They live behind the Interactions
 * API at /v1beta/interactions and are async — research jobs run for minutes.
 *
 * This module exposes the protocol as `submit` (POST a new job) and `poll`
 * (GET status until terminal). The tool layer interleaves persistence between
 * them so a fresh pod can reconnect to an in-flight job after a crash.
 *
 * `pollInteraction` throws `AsyncResearchTerminalError` when Google reports
 * `failed`/`cancelled` (the job is dead, drop the handle), and a regular
 * `Error` for transient HTTP/network problems (the job may still be running,
 * keep the handle for a future reconnect).
 */
import { AsyncResearchTerminalError } from "../types";

const INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export function isInteractionsOnlyModel(modelId: string): boolean {
  // All Gemini Deep Research variants share the `deep-research-` prefix
  // (deep-research-preview-*, deep-research-max-preview-*,
  //  deep-research-pro-preview-*, etc.) and all run via the Interactions
  // API. Match the whole family rather than enumerate suffixes — every
  // model in this line so far has been Interactions-only.
  return /^deep-research-/.test(modelId);
}

export interface SubmitInteractionOptions {
  apiKey: string;
  agent: string;
  query: string;
  abortSignal?: AbortSignal;
}

export interface PollInteractionOptions {
  apiKey: string;
  interactionId: string;
  abortSignal?: AbortSignal;
  /** Called with the accumulated transcript (thinking + text) after each poll. */
  onProgress?: (transcript: string) => void;
  pollIntervalMs?: number;
}

export interface InteractionsCitation {
  url: string;
  title?: string;
}

export interface InteractionsResearchResponse {
  text: string;
  citations: InteractionsCitation[];
  usage: { inputTokens: number; outputTokens: number };
}

interface OutputBlock {
  type: string;
  text: string;
  annotations: Array<{ type?: string; url?: string; title?: string }>;
}

export async function submitInteraction(
  opts: SubmitInteractionOptions,
): Promise<{ interactionId: string }> {
  const res = await fetch(INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent: opts.agent,
      input: opts.query,
      background: true,
      agent_config: {
        type: "deep-research",
        thinking_summaries: "auto",
      },
    }),
    signal: opts.abortSignal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Gemini Interactions submit failed (${res.status}): ${detail}`,
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const id = stringField(body, "id");
  if (!id) {
    throw new Error("Gemini Interactions submit: response missing id");
  }
  return { interactionId: id };
}

export async function pollInteraction(
  opts: PollInteractionOptions,
): Promise<InteractionsResearchResponse> {
  const url = `${INTERACTIONS_URL}/${encodeURIComponent(opts.interactionId)}`;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (true) {
    if (opts.abortSignal?.aborted) {
      throw makeAbortError(opts.abortSignal);
    }

    const res = await fetch(url, {
      headers: { "x-goog-api-key": opts.apiKey },
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Gemini Interactions poll failed (${res.status}): ${detail}`,
      );
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const status = stringField(payload, "status") ?? "in_progress";
    const outputs = parseOutputs(arrayField(payload, "outputs") ?? []);
    if (opts.onProgress) opts.onProgress(buildTranscript(outputs));

    switch (status) {
      case "completed": {
        const result = finalize(outputs, parseUsage(payload));
        // Gemini surfaces citation URLs as `vertexaisearch.cloud.google.com/...`
        // redirects rather than the underlying source. Resolve them so the
        // UI shows the real domain instead of an opaque Google URL.
        result.citations = await resolveCitationRedirects(result.citations);
        return result;
      }
      case "failed":
      case "cancelled": {
        const errMsg =
          stringField(payload, "error") ??
          stringField(payload, "message") ??
          status;
        // Terminal Google-side state — the interaction id no longer
        // resumable; surface a typed error so callers drop the handle.
        throw new AsyncResearchTerminalError(`Gemini Interactions: ${errMsg}`);
      }
      // "in_progress" / unknown → keep polling
    }

    await sleep(interval, opts.abortSignal);
  }
}

/**
 * Citation URLs from Gemini come as Vertex AI Search redirect URLs, e.g.
 * `https://vertexaisearch.cloud.google.com/grounding-api-redirect/<token>`.
 * Resolve each in parallel via a HEAD request that doesn't follow redirects;
 * if the response carries a Location header, swap in that URL. On any
 * failure (network, no Location, non-redirect response) we keep the
 * original — the UI still works, it just shows the redirect URL.
 */
async function resolveCitationRedirects(
  citations: InteractionsCitation[],
): Promise<InteractionsCitation[]> {
  const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
  const TIMEOUT_MS = 5_000;
  return Promise.all(
    citations.map(async (c) => {
      let host: string;
      try {
        host = new URL(c.url).hostname;
      } catch {
        return c;
      }
      if (host !== REDIRECT_HOST) return c;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetch(c.url, {
          method: "HEAD",
          redirect: "manual",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const location = res.headers.get("location");
        if (location) return { ...c, url: location };
        return c;
      } catch {
        return c;
      }
    }),
  );
}

function buildTranscript(outputs: OutputBlock[]): string {
  const parts: string[] = [];
  for (const o of outputs) {
    if (!o.text) continue;
    if (o.type === "thought_summary") parts.push(`*${o.text}*`);
    else if (o.type === "text") parts.push(o.text);
  }
  return parts.join("\n\n");
}

function finalize(
  outputs: OutputBlock[],
  usage: { inputTokens: number; outputTokens: number },
): InteractionsResearchResponse {
  const textParts: string[] = [];
  const citations: InteractionsCitation[] = [];
  const seenUrls = new Set<string>();

  for (const o of outputs) {
    if (o.type === "text" && o.text) textParts.push(o.text);
    for (const a of o.annotations) {
      if (a?.type === "url_citation" && a.url && !seenUrls.has(a.url)) {
        seenUrls.add(a.url);
        citations.push({ url: a.url, title: a.title });
      }
    }
  }

  return { text: textParts.join("\n\n"), citations, usage };
}

function parseOutputs(raw: unknown[]): OutputBlock[] {
  const out: OutputBlock[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const annotations = arrayField(o, "annotations");
    out.push({
      type: stringField(o, "type") ?? "text",
      text: stringField(o, "text") ?? "",
      annotations: (annotations as OutputBlock["annotations"]) ?? [],
    });
  }
  return out;
}

function parseUsage(payload: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
} {
  const usage = payload.usage as Record<string, unknown> | undefined;
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const inputTokens = numberField(usage, "input_tokens") ?? 0;
  const outputTokens =
    numberField(usage, "output_tokens") ??
    Math.max(0, (numberField(usage, "total_tokens") ?? 0) - inputTokens);
  return { inputTokens, outputTokens };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(makeAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" ? v : null;
}

function arrayField(
  obj: Record<string, unknown>,
  key: string,
): unknown[] | null {
  const v = obj[key];
  return Array.isArray(v) ? v : null;
}

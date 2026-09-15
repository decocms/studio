// Raw error.message strings can be anything: a clean string, an HTML page
// from an upstream proxy (Cloudflare 5xx), a JSON blob, a network failure.
// Classify to pick a human summary + recovery hint; preserve the original
// payload so devs can still inspect it under "Show technical details".
export function parseErrorMessage(message: string): {
  summary: string;
  rawDetails: string | null;
} {
  // A JSON envelope is the single most common shape here — every route on the
  // chat path answers `{ "error": "..." }` — and it used to render verbatim,
  // braces and escaped quotes and all. Unwrap it FIRST, then classify the
  // sentence inside on the same rules as any other message; keep the envelope
  // as the technical detail.
  const unwrapped = unwrapJsonError(message);
  if (unwrapped !== null) {
    const inner = parseErrorMessage(unwrapped);
    return { summary: inner.summary, rawDetails: inner.rawDetails ?? message };
  }

  const trimmed = message.trim();
  const looksLikeHtml =
    trimmed.startsWith("<") && /<[a-z][\s\S]*>/i.test(trimmed);
  const isCloudflare =
    /cloudflare|cf-[a-z-]+|error[\s_-]?code[\s_-]?5\d\d/i.test(trimmed);
  const isNetwork = /failed to fetch|networkerror|load failed|offline/i.test(
    trimmed,
  );
  const isTimeout = /timeout|timed out|aborted|deadline/i.test(trimmed);
  const isTooLong = trimmed.length > 240;

  // Sandbox bring-up failures carry the stable `sandbox failed to start:`
  // marker set by the sandbox runtime. Classify these BEFORE
  // the generic timeout/HTML branches — the underlying cause often contains
  // "timed out", which would otherwise collapse into the vague "took longer
  // than expected" bucket and hide the real reason from the user.
  const sandboxStart = /sandbox failed to start(?::\s*(.+))?/is.exec(trimmed);
  if (sandboxStart) {
    const cause = sandboxStart[1]?.trim().replace(/\.$/, "");
    return {
      summary: cause
        ? `Your sandbox didn't finish starting up (${cause}). Try again.`
        : "Your sandbox didn't finish starting up. Try again.",
      rawDetails: message,
    };
  }

  if (isCloudflare || (looksLikeHtml && isTooLong)) {
    return {
      summary:
        "Our servers are having a moment. Try sending again in a few seconds.",
      rawDetails: message,
    };
  }
  if (isNetwork) {
    return {
      summary: "Lost connection. Check your network and try again.",
      rawDetails: message,
    };
  }
  if (isTimeout) {
    return {
      summary: "That took longer than expected. Try again.",
      rawDetails: message,
    };
  }
  if (looksLikeHtml || isTooLong) {
    return {
      summary: "Something unexpected came back from the server. Try again.",
      rawDetails: message,
    };
  }
  return { summary: message, rawDetails: null };
}

/** The human sentence inside a `{ "error": "..." }` / `{ "message": "..." }`
 *  body, or null when the string is not one. */
function unwrapJsonError(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const { error, message: inner } = json as Record<string, unknown>;
  const text = typeof error === "string" ? error : inner;
  // Only a non-empty string, and never one that would recurse: a value that is
  // itself a JSON object is not the sentence we are after.
  return typeof text === "string" && text.trim() && !text.trim().startsWith("{")
    ? text
    : null;
}

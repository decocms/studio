// Raw error.message strings can be anything: a clean string, an HTML page
// from an upstream proxy (Cloudflare 5xx), a JSON blob, a network failure.
// Classify to pick a human summary + recovery hint; preserve the original
// payload so devs can still inspect it under "Show technical details".
export function parseErrorMessage(message: string): {
  summary: string;
  rawDetails: string | null;
} {
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
  // marker (set daemon-side in user-desktop-provider). Classify these BEFORE
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

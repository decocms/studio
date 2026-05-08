/**
 * Request bodies come base64-encoded JSON. The mesh server's daemonPost
 * helper wraps POST bodies in base64 to avoid Cloudflare WAF triggering
 * on shell commands in /bash etc. Non-freestyle paths pay a small
 * overhead (33%) for one parser and one code path.
 */
export async function parseBase64JsonBody(req: Request): Promise<unknown> {
  const raw = await req.text();
  try {
    const decoded = decodeURIComponent(
      atob(raw)
        .split("")
        .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join(""),
    );
    return JSON.parse(decoded);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse body: ${msg} | raw=${raw.slice(0, 200)}`);
  }
}

/** Build a JSON Response with the standard CORS + content-type headers. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

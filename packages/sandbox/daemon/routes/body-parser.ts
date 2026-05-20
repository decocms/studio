export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse body: ${msg}`);
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

import { jsonResponse } from "./routes/body-parser";

export function requireToken(
  req: Request,
  expectedToken: string,
): Response | null {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const provided = header.slice(prefix.length);
  if (!constantTimeEqual(provided, expectedToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

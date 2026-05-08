const encoder = new TextEncoder();

/** Encode an SSE frame to bytes: `event: <name>\ndata: <payload>\n\n`. */
export function sseFormat(event: string, payload: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${payload}\n\n`);
}

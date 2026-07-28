/** Thrown by {@link readBoundedText} when a response body exceeds its cap. */
export class UpstreamPayloadTooLargeError extends Error {}

/**
 * Read a `Response` body as text, aborting once it exceeds `maxBytes`. Used
 * anywhere we read a response from an upstream we don't control (the sandbox
 * daemon, a customer's own preview server) so a runaway or malicious body
 * never gets buffered fully into this process's memory with no ceiling.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpstreamPayloadTooLargeError(
        `Upstream response exceeded ${maxBytes} bytes`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

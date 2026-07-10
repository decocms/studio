/**
 * Daemon-side dispatch adapter: streams one harness run through the
 * harness-runner subprocess. Yields the same raw UIMessageChunks an
 * in-process `harness.stream()` would, so routes/dispatch.ts (and the whole
 * client-facing SSE contract) is untouched by the extraction:
 *   - runner `error` event → throw (dispatch wraps it as `harness_crashed`
 *     with the same message, exactly like an in-process harness throw);
 *   - runner death / stream ending before `done` → throw → `harness_crashed`;
 *   - abort (`input.signal`) aborts the /run fetch, which the runner sees as
 *     its request abort and tears the CLI down.
 */
import type { HarnessStreamInput } from "@decocms/harness/types";
import { dispatchSSEEventSchema } from "../../dispatch/index";
import { ensureHarnessRunner } from "./supervisor";

export async function* streamViaHarnessRunner(
  harnessId: string,
  input: HarnessStreamInput,
): AsyncGenerator<unknown> {
  const runner = await ensureHarnessRunner();
  const res = await fetch(`http://127.0.0.1:${runner.port}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    // `signal: undefined` drops the non-serializable AbortSignal from the
    // JSON body; the runner reconstructs it from the request lifetime.
    body: JSON.stringify({ harnessId, input: { ...input, signal: undefined } }),
    signal: input.signal,
  });
  if (res.status !== 200 || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`harness-runner /run responded ${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          const event = dispatchSSEEventSchema.parse(JSON.parse(line));
          if (event.type === "ui-message-chunk") {
            yield event.chunk;
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else {
            return;
          }
        }
        nl = buf.indexOf("\n");
      }
    }
    throw new Error("harness-runner stream ended before done");
  } finally {
    reader.cancel().catch(() => {});
  }
}

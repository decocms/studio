import { describe, expect, it } from "bun:test";
import { parseMessagesRef } from "../../../../apps/mesh/src/harnesses/offload-messages";

/**
 * Guards the detection contract the /dispatch re-inflate branch relies on.
 *
 * The route reads the raw `{ harnessId, input, messagesRef? }` envelope and
 * branches on `parseMessagesRef(envelope)`:
 *   - non-null  → offload path: defer all work into the SSE stream, fetch the
 *                 ref, splice `messages` back into `input`, then validate.
 *   - null      → today's synchronous validate + 4xx + tombstone + stream.
 *
 * If `parseMessagesRef` ever changes which shapes it accepts, the route's
 * branch silently shifts; these assertions break first.
 */
describe("/dispatch re-inflate detection contract", () => {
  const validRef = {
    url: "https://minio.example.com/link-dispatch/req-1",
    bytes: 1024,
    sha256: "abc123",
  };

  it("detects a well-formed offload envelope", () => {
    const env = { harnessId: "claude-code", input: {}, messagesRef: validRef };
    expect(parseMessagesRef(env)).toEqual(validRef);
  });

  it("treats a plain (non-offload) dispatch envelope as null", () => {
    const env = {
      harnessId: "claude-code",
      input: { runId: "run-1", messages: [] },
    };
    expect(parseMessagesRef(env)).toBeNull();
  });

  it("rejects a malformed messagesRef (missing/typed-wrong fields)", () => {
    expect(
      parseMessagesRef({ harnessId: "x", input: {}, messagesRef: {} }),
    ).toBeNull();
    expect(
      parseMessagesRef({
        harnessId: "x",
        input: {},
        messagesRef: { url: "https://s/x", bytes: 1 }, // no sha256
      }),
    ).toBeNull();
    expect(
      parseMessagesRef({
        harnessId: "x",
        input: {},
        messagesRef: { url: "https://s/x", bytes: "1024", sha256: "ab" }, // bytes not number
      }),
    ).toBeNull();
  });

  it("rejects non-object / null envelopes without throwing", () => {
    expect(parseMessagesRef(null)).toBeNull();
    expect(parseMessagesRef(undefined)).toBeNull();
    expect(parseMessagesRef("nope")).toBeNull();
    expect(parseMessagesRef(42)).toBeNull();
  });
});

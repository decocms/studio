import { describe, expect, it } from "bun:test";
import { __test } from "./fetch";

const { benignSandbox4xx, benignPreview404, isConnectionClosed } = __test;

describe("benignSandbox4xx", () => {
  it("treats daemon 404 as gone", () => {
    expect(benignSandbox4xx(404, "/_sandbox/git/status")).toBe("daemon_gone");
  });

  it("treats daemon 409 as not-ready", () => {
    expect(benignSandbox4xx(409, "/_sandbox/git/status")).toBe(
      "daemon_not_ready",
    );
    expect(benignSandbox4xx(409, "/_sandbox/events")).toBe("daemon_not_ready");
  });

  it("treats a GC'd sandbox claim 404 as gone", () => {
    expect(
      benignSandbox4xx(
        404,
        "/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/agent-sandbox-system/sandboxclaims/tawny-spark",
      ),
    ).toBe("claim_gone");
  });

  it("does not suppress non-lifecycle statuses on daemon paths", () => {
    expect(benignSandbox4xx(500, "/_sandbox/git/status")).toBeNull();
    expect(benignSandbox4xx(403, "/_sandbox/git/status")).toBeNull();
  });

  it("does not suppress 409 outside the daemon", () => {
    expect(benignSandbox4xx(409, "/api/links/work")).toBeNull();
  });

  it("does not suppress a claim-path 409 (only 404 is benign there)", () => {
    expect(benignSandbox4xx(409, "/apis/x/sandboxclaims/foo")).toBeNull();
  });
});

describe("benignPreview404", () => {
  it("treats a 404 on the deco-site probe paths as not-a-deco-site", () => {
    expect(benignPreview404(404, "/.decofile")).toBe("not_a_deco_site");
    expect(benignPreview404(404, "/live/_meta")).toBe("not_a_deco_site");
    // A site with no icon sprite is fine — previews fall back to text.
    expect(benignPreview404(404, "/sprites.svg")).toBe("not_a_deco_site");
  });

  it("does not suppress non-404 statuses on those paths", () => {
    expect(benignPreview404(500, "/.decofile")).toBeNull();
    expect(benignPreview404(403, "/live/_meta")).toBeNull();
  });

  it("does not suppress 404 on unrelated paths", () => {
    expect(benignPreview404(404, "/live/_meta/extra")).toBeNull();
    expect(benignPreview404(404, "/api/links/work")).toBeNull();
  });
});

describe("isConnectionClosed", () => {
  it("matches Bun's socket-closed message", () => {
    expect(
      isConnectionClosed(
        new Error(
          "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        ),
      ),
    ).toBe(true);
  });

  it("matches reset / broken-pipe codes", () => {
    const reset = Object.assign(new Error("read"), { code: "ECONNRESET" });
    const pipe = Object.assign(new Error("write"), { code: "EPIPE" });
    expect(isConnectionClosed(reset)).toBe(true);
    expect(isConnectionClosed(pipe)).toBe(true);
  });

  it("ignores unrelated errors and non-errors", () => {
    expect(isConnectionClosed(new Error("ENOTFOUND"))).toBe(false);
    expect(
      isConnectionClosed(
        Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
    expect(isConnectionClosed("nope")).toBe(false);
    expect(isConnectionClosed(null)).toBe(false);
  });
});

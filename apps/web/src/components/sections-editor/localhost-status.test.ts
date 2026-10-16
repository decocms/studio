import { describe, expect, it } from "bun:test";
import type { ContentBackend } from "./content-backend";
import { localhostStatus } from "./localhost-status";

const local = (problem?: { reason: "not-answering" | "outdated" }) =>
  ({ kind: "unavailable", source: "local", problem }) as ContentBackend;
const connected = {
  kind: "protocol",
  source: "local",
} as unknown as ContentBackend;

describe("localhostStatus", () => {
  it("maps the editor's backend and Chrome's permission to one state", () => {
    const at = (
      backend: ContentBackend,
      access: "granted" | "denied" = "granted",
    ) => localhostStatus({ backend, access }).kind;
    expect(at({ kind: "pending" })).toBe("connecting");
    expect(at(connected)).toBe("connected");
    expect(at(local())).toBe("not-running");
    expect(at(local({ reason: "not-answering" }))).toBe("not-running");
    expect(at(local({ reason: "not-answering" }), "denied")).toBe(
      "needs-permission",
    );
    expect(at(local({ reason: "outdated" }))).toBe("problem");
  });
});

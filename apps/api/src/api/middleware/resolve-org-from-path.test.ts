import { describe, expect, it } from "bun:test";
import { isServiceTokenPath } from "./resolve-org-from-path";

describe("isServiceTokenPath", () => {
  it("matches every service-token route, and only directly under /api/:org", () => {
    expect(
      isServiceTokenPath("/api/org_1/vault/connections/conn_x/access-token"),
    ).toBe(true);
    expect(
      isServiceTokenPath("/api/org_1/vault/connections/conn_x/configuration"),
    ).toBe(true);
    expect(isServiceTokenPath("/api/org_1/internal/task-board/import")).toBe(
      true,
    );
    expect(isServiceTokenPath("/api/org_1/internal/task-board/resolve")).toBe(
      true,
    );
    expect(
      isServiceTokenPath(
        "/api/org_1/internal/commerce-diagnostic/share-invite",
      ),
    ).toBe(true);
    expect(isServiceTokenPath("/api/org_1/internal/organization-notices")).toBe(
      true,
    );
    expect(isServiceTokenPath("/api/org_1/internal/repositories/resolve")).toBe(
      true,
    );
    for (const route of [
      "tree",
      "file",
      "search",
      "change-requests",
      "commits",
    ]) {
      expect(
        isServiceTokenPath(`/api/org_1/internal/repositories/repo_x/${route}`),
      ).toBe(true);
    }
  });

  it("rejects everything else", () => {
    // Other org routes never resolve by id.
    expect(isServiceTokenPath("/api/org_1/tools/TASK_BOARD_ITEM_CREATE")).toBe(
      false,
    );
    // Wrong arity / truncated shapes.
    expect(
      isServiceTokenPath("/api/org_1/vault/connections/access-token"),
    ).toBe(false);
    expect(isServiceTokenPath("/api/org_1/internal/task-board")).toBe(false);
    // Per-route, not a wildcard under the id.
    expect(
      isServiceTokenPath("/api/org_1/internal/repositories/repo_x/archive"),
    ).toBe(false);
    expect(isServiceTokenPath("/api/org_1/internal/repositories")).toBe(false);
    expect(
      isServiceTokenPath("/api/org_1/internal/repositories/repo_x/tree/extra"),
    ).toBe(false);
    expect(
      isServiceTokenPath("/api/org_1/internal/task-board/import/extra"),
    ).toBe(false);
    expect(
      isServiceTokenPath("/api/org_1/internal/task-board/resolve/extra"),
    ).toBe(false);
    // The old suffix regex matched ANY path ending in a service suffix — a
    // deeper path (e.g. an MCP proxy echoing it) must NOT resolve by id.
    expect(
      isServiceTokenPath(
        "/api/org_1/mcp/conn/vault/connections/conn_x/access-token",
      ),
    ).toBe(false);
    // Outside the /api/:org mount.
    expect(isServiceTokenPath("/vault/connections/conn_x/access-token")).toBe(
      false,
    );
  });
});

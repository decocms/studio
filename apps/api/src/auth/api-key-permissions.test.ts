import { describe, expect, it } from "bun:test";
import { role } from "@decocms/better-auth/plugins/access";
import { buildWildcardPermission } from "../core/permission-wildcard";
import type { Permission } from "../storage/types";
import {
  checkApiKeyPermission,
  checkRolePermission,
} from "./api-key-permissions";

describe("checkApiKeyPermission", () => {
  it("grants when the exact (resource, tool) is in the allowlist", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { self: ["ORGANIZATION_GET"] },
      ),
    ).toBe(true);
  });

  it("denies a tool outside the allowlist (the escalation we block)", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { self: ["API_KEY_CREATE"] },
      ),
    ).toBe(false);
  });

  it("denies when the resource is not granted at all", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { conn_123: ["SEND_MESSAGE"] },
      ),
    ).toBe(false);
  });

  it("grants every tool for a resource with a wildcard", () => {
    expect(checkApiKeyPermission({ self: ["*"] }, { self: ["ANYTHING"] })).toBe(
      true,
    );
  });

  it("honors a wildcard `*` resource granting all tools (full key)", () => {
    expect(
      checkApiKeyPermission({ "*": ["*"] }, { conn_9: ["SEND_MESSAGE"] }),
    ).toBe(true);
    expect(checkApiKeyPermission({ "*": ["*"] }, { self: ["ANYTHING"] })).toBe(
      true,
    );
  });

  it("denies everything for an empty / absent allowlist (fail-closed)", () => {
    expect(checkApiKeyPermission({}, { self: ["ORGANIZATION_GET"] })).toBe(
      false,
    );
  });

  it("requires ALL requested tools to be covered", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { self: ["ORGANIZATION_GET", "API_KEY_CREATE"] },
      ),
    ).toBe(false);
  });

  it("falls back to a `*` resource even when a narrower per-resource grant exists", () => {
    expect(
      checkApiKeyPermission(
        { conn_1: ["READ"], "*": ["*"] },
        { conn_1: ["WRITE"] },
      ),
    ).toBe(true);
  });

  it("unions a non-wildcard `*` resource's tools with the per-resource grant", () => {
    expect(
      checkApiKeyPermission(
        { conn_1: ["READ"], "*": ["WRITE"] },
        { conn_1: ["READ", "WRITE"] },
      ),
    ).toBe(true);
    expect(
      checkApiKeyPermission(
        { conn_1: ["READ"], "*": ["WRITE"] },
        { conn_1: ["DELETE"] },
      ),
    ).toBe(false);
  });

  it("lets a denied tool win over a wildcard", () => {
    const granted = { conn_1: ["*", "!DELETE"] };
    expect(checkApiKeyPermission(granted, { conn_1: ["READ"] })).toBe(true);
    expect(checkApiKeyPermission(granted, { conn_1: ["DELETE"] })).toBe(false);
    expect(
      checkApiKeyPermission(
        { conn_1: ["!DELETE"], "*": ["*"] },
        { conn_1: ["DELETE"] },
      ),
    ).toBe(false);
  });

  it("grants whole connections through the connections scope, never self", () => {
    const granted = {
      connections: ["*", "!conn_2"],
      self: ["ORGANIZATION_GET"],
    };
    expect(checkApiKeyPermission(granted, { conn_1: ["ANY_TOOL"] })).toBe(true);
    expect(checkApiKeyPermission(granted, { conn_2: ["ANY_TOOL"] })).toBe(
      false,
    );
    expect(checkApiKeyPermission(granted, { self: ["API_KEY_CREATE"] })).toBe(
      false,
    );
  });

  it("lets a connection's denied scope win over its own entry", () => {
    expect(
      checkApiKeyPermission(
        { connections: ["!conn_2"], conn_2: ["READ"] },
        { conn_2: ["READ"] },
      ),
    ).toBe(false);
  });

  it("keeps a connection entry's denials under the connections scope", () => {
    const granted = { connections: ["*"], conn_1: ["!DELETE"] };
    expect(checkApiKeyPermission(granted, { conn_1: ["READ"] })).toBe(true);
    expect(checkApiKeyPermission(granted, { conn_1: ["DELETE"] })).toBe(false);
  });
});

describe("checkRolePermission", () => {
  it("ignores a `*` resource key", () => {
    expect(
      checkRolePermission({ "*": ["*"] }, { conn_9: ["SEND_MESSAGE"] }),
    ).toBe(false);
  });

  it("applies deny entries and the connections scope like a key", () => {
    const statement = { self: ["*", "!API_KEY_CREATE"], connections: ["*"] };
    expect(checkRolePermission(statement, { self: ["API_KEY_CREATE"] })).toBe(
      false,
    );
    expect(checkRolePermission(statement, { conn_9: ["SEND_MESSAGE"] })).toBe(
      true,
    );
  });

  // Roles stored before deny entries and the connections scope must get the
  // answer Better Auth gave them: its real `role().authorize()`, probed exact
  // then wildcard, OR-ed over a member's roles (`hasPermissionFn`). Callers
  // check one resource at a time (AccessControl), so requests do too.
  it("matches Better Auth for roles without deny entries or connections", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)] as T;
    const subset = <T>(items: readonly T[]) =>
      items.filter(() => random() < 0.4);
    const resources = ["self", "conn_a", "conn_b"] as const;
    const tools = ["A", "B", "*"] as const;
    const statement = (): Permission =>
      Object.fromEntries(
        subset([...resources, "*"]).map((resource) => [
          resource,
          subset(tools),
        ]),
      );
    const betterAuth = (statements: Permission[], requested: Permission) =>
      statements.some((one) => {
        const r = role(one);
        return (
          r.authorize(requested).success ||
          r.authorize(buildWildcardPermission(requested)).success
        );
      });

    const mismatches: unknown[] = [];
    for (let i = 0; i < 20_000; i++) {
      const statements = Array.from({ length: 1 + (i % 2) }, statement);
      const requested = {
        [pick(resources)]: [pick(tools), ...(random() < 0.3 ? ["B"] : [])],
      };
      const ours = statements.some((one) =>
        checkRolePermission(one, requested),
      );
      if (ours !== betterAuth(statements, requested)) {
        mismatches.push({ statements, requested, ours });
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

import { describe, expect, it } from "bun:test";
import {
  authoringOperator,
  coAuthorFromStudioContext,
  commitOperatorFromStudioContext,
} from "./co-author-identity";

const JANE = { id: "u1", name: "Jane", email: "jane@example.com" };

/**
 * A context whose org settings carry `flags`; no org at all when null. Each
 * one gets its own org id: `orgFlagsCached` keeps a process-wide entry per
 * org, so a shared id would let one case answer the next.
 */
const ctx = (flags: Record<string, unknown> | null, user: unknown = JANE) =>
  ({
    auth: { user },
    organization:
      flags === null ? undefined : { id: `org_${crypto.randomUUID()}` },
    storage: {
      organizationSettings: { get: async () => ({ flags }) },
    },
  }) as never;

describe("coAuthorFromStudioContext", () => {
  it("returns undefined when auth user has no display name", () => {
    expect(
      coAuthorFromStudioContext({
        auth: { user: { id: "u1", email: "jane@example.com" } },
      } as never),
    ).toBeUndefined();
  });
});

describe("commitOperatorFromStudioContext", () => {
  it("lets the editor author when the flag is on", async () => {
    expect(
      await commitOperatorFromStudioContext(
        ctx({ commits_authored_by_editor: true }),
      ),
    ).toEqual({
      userName: "Jane",
      userEmail: "jane@example.com",
      operatorId: "u1",
      authorsCommit: true,
    });
  });

  it("withholds authorship when the flag is unset, off, or org-less", async () => {
    for (const flags of [{}, { commits_authored_by_editor: false }]) {
      expect(await commitOperatorFromStudioContext(ctx(flags))).toMatchObject({
        userName: "Jane",
        authorsCommit: false,
      });
    }
    expect(await commitOperatorFromStudioContext(ctx(null))).toMatchObject({
      authorsCommit: false,
    });
  });

  it("is undefined without a usable user, before any settings read", async () => {
    expect(
      await commitOperatorFromStudioContext(
        ctx({ commits_authored_by_editor: true }, { id: "u1" }),
      ),
    ).toBeUndefined();
  });
});

describe("authoringOperator", () => {
  it("passes the operator through only when they may author", () => {
    const jane = { userName: "Jane", userEmail: "jane@example.com" };
    expect(authoringOperator({ ...jane, authorsCommit: true })).toEqual({
      ...jane,
      authorsCommit: true,
    });
    expect(authoringOperator({ ...jane, authorsCommit: false })).toBeNull();
    expect(authoringOperator(undefined)).toBeNull();
  });
});

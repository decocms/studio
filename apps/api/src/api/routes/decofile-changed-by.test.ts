/**
 * `GET /decofile/:project/:branch/changed-by`: who made the other change, for
 * the site editor's "someone else changed this" dialog. A Fast Preview draft
 * answers from each block file's latest commit on the branch (one history
 * call per block), mapped to the org's members.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { appendCoAuthorTrailer } from "@decocms/sandbox/shared";
import type { StudioContext } from "@/core/studio-context";
import type { ListCommitsParams, RepoInsightsClient } from "@/git-providers";
import type { MemberLookup } from "@/decofile/changed-by";
import type { Env } from "../hono-env";
import { createDecofileRoutes } from "./decofile";

const ORG = "org";
const AT = "2026-10-16T12:00:00Z";

function setup(options: {
  user?: { id: string; email?: string } | null;
  /** path → the latest commit's message and author on the branch. */
  history?: Record<
    string,
    { message: string; author?: { name: string; email: string | null } }
  >;
  members?: Awaited<ReturnType<MemberLookup>>;
}) {
  const project = {
    id: "p1",
    organization_id: ORG,
    metadata: {
      repository: { owner: "acme", name: "site" },
      previewServerUrl: "https://acme.example.com",
    },
    connections: [],
  };
  const user = options.user === undefined ? { id: "u-bob" } : options.user;
  const ctx = {
    organization: { id: ORG, slug: ORG },
    auth: user
      ? { user: { ...user, role: "owner" }, permissionsOrganizationId: ORG }
      : {},
    access: { getRole: () => "owner", check: async () => {} },
    storage: {
      virtualMcps: {
        findById: async (id: string) => (id === project.id ? project : null),
      },
      orgSites: { getByProject: async () => null },
    },
  } as unknown as StudioContext;
  const historyCalls: ListCommitsParams[] = [];
  const insights = {
    listCommits: async (params: ListCommitsParams) => {
      historyCalls.push(params);
      const row = options.history?.[params.path ?? ""];
      return {
        items: row
          ? [
              {
                sha: "c1",
                date: AT,
                message: row.message.split("\n")[0]!,
                body: row.message.split("\n").slice(1).join("\n").trim(),
                author: {
                  name: row.author?.name ?? "decocms[bot]",
                  email: row.author?.email ?? null,
                  login: row.author ? null : "decocms[bot]",
                },
              },
            ]
          : [],
        nextCursor: null,
      };
    },
  } as unknown as RepoInsightsClient;
  const memberQueries: unknown[] = [];
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  app.route(
    "/decofile",
    createDecofileRoutes({
      insightsClientFor: async () => insights,
      membersFor: () => async (query) => {
        memberQueries.push(query);
        return options.members ?? [];
      },
    }),
  );
  return { app, historyCalls, memberQueries };
}

const trailer = (name: string, email: string) =>
  appendCoAuthorTrailer("Update SharedHero", {
    userName: name,
    userEmail: email,
  });

describe("changed-by (Fast Preview)", () => {
  it("answers each block's latest change on the branch, as the org member, with one history call per block", async () => {
    const { app, historyCalls, memberQueries } = setup({
      history: {
        ".deco/blocks/SharedHero.json": {
          message: trailer("ana", "ana@acme.com"),
        },
      },
      members: [
        {
          userId: "u-ana",
          name: "Ana Souza",
          email: "ana@acme.com",
          image: "https://img/ana.png",
        },
      ],
    });
    const res = await app.request(
      "/decofile/p1/draft-1/changed-by?block=SharedHero&block=pages%2Fhome",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changedBy: {
        SharedHero: {
          name: "Ana Souza",
          email: "ana@acme.com",
          avatarUrl: "https://img/ana.png",
          at: "2026-10-16T12:00:00.000Z",
        },
      },
    });
    expect(historyCalls.map((c) => [c.ref, c.path, c.limit])).toEqual([
      ["draft-1", ".deco/blocks/SharedHero.json", 1],
      ["draft-1", ".deco/blocks/pages%2Fhome.json", 1],
    ]);
    expect(memberQueries).toEqual([{ emails: ["ana@acme.com"], userIds: [] }]);
  });

  it("the viewer's own save from another tab is `you`", async () => {
    const { app } = setup({
      user: { id: "u-ana", email: "ana@acme.com" },
      history: {
        ".deco/blocks/SharedHero.json": {
          message: trailer("Ana Souza", "ana@acme.com"),
        },
      },
    });
    const res = await app.request(
      "/decofile/p1/main/changed-by?block=SharedHero",
    );
    expect(await res.json()).toEqual({
      changedBy: {
        SharedHero: {
          name: "Ana Souza",
          at: "2026-10-16T12:00:00.000Z",
          you: true,
        },
      },
    });
  });

  it("a developer's push without a trailer shows its git author", async () => {
    const { app } = setup({
      history: {
        ".deco/blocks/SharedHero.json": {
          message: "fix hero copy",
          author: { name: "Dev Person", email: "dev@else.com" },
        },
      },
    });
    const res = await app.request(
      "/decofile/p1/main/changed-by?block=SharedHero",
    );
    expect(await res.json()).toEqual({
      changedBy: {
        SharedHero: { name: "Dev Person", at: "2026-10-16T12:00:00.000Z" },
      },
    });
  });

  it("no history: nothing to say, still 200", async () => {
    const { app } = setup({});
    const res = await app.request(
      "/decofile/p1/main/changed-by?block=SharedHero",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changedBy: {} });
  });

  it("needs a signed-in member and 1 to 5 block keys", async () => {
    const anonymous = setup({ user: null });
    expect(
      (await anonymous.app.request("/decofile/p1/main/changed-by?block=a"))
        .status,
    ).toBe(401);
    const { app, historyCalls } = setup({});
    expect((await app.request("/decofile/p1/main/changed-by")).status).toBe(
      400,
    );
    const six = Array.from({ length: 6 }, (_, i) => `block=b${i}`).join("&");
    expect(
      (await app.request(`/decofile/p1/main/changed-by?${six}`)).status,
    ).toBe(400);
    expect(historyCalls).toEqual([]);
  });
});

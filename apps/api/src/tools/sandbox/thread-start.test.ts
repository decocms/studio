import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import * as choices from "../../git-providers/repo-choices";
import type { RepoChoice } from "../../git-providers/repo-choices";
import * as chats from "../../harnesses/sandbox-only-chats";
import { COLLECTION_THREADS_CREATE } from "../thread/create";
import { THREAD_SANDBOX_START, findRepoChoice } from "./thread-start";

const choice = (id: string, owner: string, name: string): RepoChoice => ({
  id,
  owner,
  name,
  label: `${owner}/${name}`,
  webUrl: `https://github.com/${owner}/${name}`,
  provider: "github",
  repository: null,
  connectionId: id,
  installationId: 1,
});

describe("findRepoChoice", () => {
  const site = choice("conn_1", "Acme", "Site");
  const api = choice("conn_2", "acme", "api");

  it("matches an id, then owner/name in any case", () => {
    expect(findRepoChoice([site, api], "conn_2")).toBe(api);
    expect(findRepoChoice([site, api], "acme/site")).toBe(site);
  });

  it("names the linked repositories when nothing matches", () => {
    expect(() => findRepoChoice([site, api], "acme/web")).toThrow(
      'No repository "acme/web" is linked to this organization. Linked: Acme/Site (id: conn_1), acme/api (id: conn_2).',
    );
    expect(() => findRepoChoice([], "acme/web")).toThrow("Linked: none.");
  });

  it("asks for an id when owner/name is ambiguous", () => {
    const gitlab = {
      ...choice("repo_1", "acme", "site"),
      provider: "gitlab" as const,
    };
    expect(() => findRepoChoice([site, gitlab], "acme/site")).toThrow(
      "names several repositories; pass one id: Acme/Site (id: conn_1), acme/site (id: repo_1).",
    );
  });
});

describe("THREAD_SANDBOX_START without a threadId", () => {
  const started = {
    virtualMcpId: "decopilot_org_1",
    branch: "thread:thrd_new",
    sandboxHandle: null,
    previewUrl: null,
  };
  const ctx = {
    auth: { user: { id: "user_1" } },
    organization: { id: "org_1" },
    access: { check: async () => {} },
  } as unknown as StudioContext;
  const create = () =>
    spyOn(COLLECTION_THREADS_CREATE, "execute").mockResolvedValue({
      item: { id: "thrd_new", branch: null },
    } as never);
  const start = () =>
    spyOn(chats, "startThreadSandbox").mockResolvedValue(started);
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

  it("creates a sandbox chat on the default agent and starts it", async () => {
    const createSpy = create();
    const startSpy = start();
    spies.push(createSpy, startSpy);
    const out = await THREAD_SANDBOX_START.handler({ wait: false }, ctx);
    expect(createSpy.mock.calls[0]?.[0]).toEqual({
      data: { virtual_mcp_id: "decopilot_org_1", runtime: "sandbox" },
    });
    expect(startSpy.mock.calls[0]?.[1]).toEqual({
      id: "thrd_new",
      virtual_mcp_id: "decopilot_org_1",
      branch: null,
    });
    expect(out).toEqual({ threadId: "thrd_new", ...started });
  });

  it("refuses a repository for a project before creating a chat", async () => {
    const createSpy = create();
    spies.push(createSpy);
    await expect(
      THREAD_SANDBOX_START.handler(
        { wait: false, virtualMcpId: "vir_1", repository: "acme/site" },
        ctx,
      ),
    ).rejects.toThrow("Only chats on the default agent can load a repository");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("refuses an unlinked repository before creating a chat", async () => {
    const createSpy = create();
    const listSpy = spyOn(choices, "listOrgRepoChoices").mockResolvedValue([]);
    spies.push(createSpy, listSpy);
    await expect(
      THREAD_SANDBOX_START.handler(
        { wait: false, repository: "acme/missing" },
        ctx,
      ),
    ).rejects.toThrow('No repository "acme/missing"');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("takes a threadId or a virtualMcpId, not both", () => {
    expect(
      THREAD_SANDBOX_START.inputSchema.safeParse({
        threadId: "thrd_1",
        virtualMcpId: "vir_1",
      }).success,
    ).toBe(false);
  });
});

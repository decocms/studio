import { describe, expect, test } from "bun:test";
import {
  blockKeysOfWrite,
  contentProbesEnabled,
  hostedDraftSession,
  isProtocolProject,
  mergePolledBlocks,
  newBlocksEditorEnabled,
  selectContentBackend,
  servePreviewUrl,
} from "./content-backend";

describe("selectContentBackend", () => {
  const v8 = {
    hasProject: true,
    isV8Project: true,
    hasServeConnection: false,
    runtime: "cms" as const,
    githubSite: "v8" as const,
  };
  const v7 = { ...v8, isV8Project: false, githubSite: "v7" as const };
  const SITES = ["v8", "v7", "loading", "error"] as const;
  const SANDBOX_SITES = [...SITES, "unavailable", undefined] as const;

  describe("v7 project (no marker): as on main, in every org", () => {
    test("is always legacy right away, whatever the probes say", () => {
      for (const runtime of ["cms", "sandbox"] as const) {
        for (const githubSite of SITES) {
          for (const sandboxSite of SANDBOX_SITES) {
            expect(
              selectContentBackend({
                ...v7,
                runtime,
                githubSite,
                sandboxSite,
              }),
            ).toBe("legacy");
          }
        }
      }
    });

    test("never switches mid-session, even when the probe would say v8 (an upgrade branch)", () => {
      expect(selectContentBackend({ ...v7, githubSite: "v8" })).toBe("legacy");
      expect(
        selectContentBackend({ ...v7, runtime: "sandbox", sandboxSite: "v8" }),
      ).toBe("legacy");
    });

    test("runs no probe at all", () => {
      for (const runtime of ["cms", "sandbox"] as const) {
        for (const hasServeConnection of [true, false]) {
          expect(
            contentProbesEnabled({
              isV8Project: false,
              hasServeConnection,
              runtime,
              workingTreeReady: true,
            }),
          ).toEqual({ github: false, sandbox: false });
        }
      }
    });
  });

  describe("v8 project (marker)", () => {
    test("Localhost (a connected deco serve) wins; its own schema decides", () => {
      expect(
        selectContentBackend({
          ...v8,
          hasServeConnection: true,
          runtime: "sandbox",
          githubSite: "v7",
        }),
      ).toBe("protocol-local");
    });

    test("a cms session waits for the GitHub probe (the hosted draft)", () => {
      expect(selectContentBackend({ ...v8, githubSite: "loading" })).toBe(
        "pending",
      );
      expect(selectContentBackend(v8)).toBe("protocol-github");
    });

    test("a v7 answer falls back to legacy", () => {
      expect(selectContentBackend({ ...v8, githubSite: "v7" })).toBe("legacy");
    });

    test("a failed probe is unavailable (retried), never the v7 editor", () => {
      expect(selectContentBackend({ ...v8, githubSite: "error" })).toBe(
        "unavailable-github",
      );
      expect(
        selectContentBackend({
          ...v8,
          runtime: "sandbox",
          sandboxSite: "error",
        }),
      ).toBe("unavailable-sandbox");
    });

    test("a sandbox session waits for the daemon, then uses its protocol", () => {
      const sandbox = {
        ...v8,
        runtime: "sandbox" as const,
        githubSite: "v7" as const,
      };
      for (const sandboxSite of [
        "unavailable",
        "loading",
        undefined,
      ] as const) {
        expect(selectContentBackend({ ...sandbox, sandboxSite })).toBe(
          "pending",
        );
      }
      expect(selectContentBackend({ ...sandbox, sandboxSite: "v8" })).toBe(
        "protocol-sandbox",
      );
      // An older daemon (404) or a v7 working tree reads as v7: legacy.
      expect(selectContentBackend({ ...sandbox, sandboxSite: "v7" })).toBe(
        "legacy",
      );
    });

    test("probes in every org, but not while Localhost is connected", () => {
      const input = {
        isV8Project: true,
        hasServeConnection: false,
        runtime: "cms" as const,
        workingTreeReady: false,
      };
      expect(contentProbesEnabled(input)).toEqual({
        github: true,
        sandbox: false,
      });
      expect(
        contentProbesEnabled({
          ...input,
          runtime: "sandbox",
          workingTreeReady: true,
        }),
      ).toEqual({ github: false, sandbox: true });
      expect(
        contentProbesEnabled({ ...input, hasServeConnection: true }),
      ).toEqual({ github: false, sandbox: false });
    });
  });

  test("the account-less /site-editor: only its deco serve, whose schema decides", () => {
    // No marker there (no project to mark): the connection is the backend.
    expect(
      selectContentBackend({
        ...v7,
        hasServeConnection: true,
      }),
    ).toBe("protocol-local");
  });

  test("without a project (SEO, blog forms) it is legacy right away", () => {
    for (const isV8Project of [true, false]) {
      for (const hasServeConnection of [true, false]) {
        expect(
          selectContentBackend({
            ...v8,
            isV8Project,
            hasServeConnection,
            hasProject: false,
            githubSite: "loading",
          }),
        ).toBe("legacy");
      }
    }
  });
});

describe("isProtocolProject", () => {
  test("a protocol endpoint, usable or not", () => {
    expect(isProtocolProject({ kind: "unavailable", source: "local" })).toBe(
      true,
    );
    expect(isProtocolProject({ kind: "legacy" })).toBe(false);
    expect(isProtocolProject({ kind: "pending" })).toBe(false);
  });
});

describe("mergePolledBlocks", () => {
  test("the remote map wins", () => {
    expect(
      mergePolledBlocks({ a: 1, b: 2 }, { a: 0, c: 3 }, new Set()),
    ).toEqual({ a: 1, b: 2 });
  });

  test("entries still being saved keep their local value", () => {
    expect(
      mergePolledBlocks(
        { a: 1, b: 2 },
        { a: "editing", b: 2, d: "new" },
        new Set(["a", "d"]),
      ),
    ).toEqual({ a: "editing", b: 2, d: "new" });
  });

  test("an entry being deleted stays deleted", () => {
    expect(
      mergePolledBlocks({ a: 1, gone: 2 }, { a: 1 }, new Set(["gone"])),
    ).toEqual({ a: 1 });
  });

  test("with no local copy, the remote map as is", () => {
    const remote = { a: 1 };
    expect(mergePolledBlocks(remote, undefined, new Set(["a"]))).toBe(remote);
  });
});

describe("blockKeysOfWrite", () => {
  test("reads the save, delete and move mutation shapes", () => {
    expect(blockKeysOfWrite({ blockKey: "home", data: {} })).toEqual(["home"]);
    expect(
      blockKeysOfWrite({ writes: { b: {}, c: {} }, deletes: ["a", 1] }),
    ).toEqual(["b", "c", "a"]);
    expect(blockKeysOfWrite(undefined)).toEqual([]);
    expect(blockKeysOfWrite("nope")).toEqual([]);
  });
});

describe("hostedDraftSession", () => {
  const protocol = (source: "github" | "local" | "sandbox") =>
    ({
      kind: "protocol",
      source,
      client: {},
      describe: {},
      cacheKeySuffix: "",
    }) as unknown as Parameters<typeof hostedDraftSession>[0];

  test("a v8 site on the GitHub backend, usable, unreachable or still deciding", () => {
    expect(hostedDraftSession(protocol("github"), true)).toBe(true);
    expect(
      hostedDraftSession({ kind: "unavailable", source: "github" }, true),
    ).toBe(true);
    expect(hostedDraftSession({ kind: "pending" }, true)).toBe(true);
  });

  test("never a v7 site, whatever its backend", () => {
    expect(hostedDraftSession({ kind: "legacy" }, false)).toBe(false);
    expect(hostedDraftSession({ kind: "pending" }, false)).toBe(false);
    expect(hostedDraftSession(protocol("github"), false)).toBe(false);
  });

  test("not Localhost, a sandbox, or a v8 site on the v7 editor", () => {
    expect(hostedDraftSession(protocol("local"), true)).toBe(false);
    expect(hostedDraftSession(protocol("sandbox"), true)).toBe(false);
    expect(
      hostedDraftSession({ kind: "unavailable", source: "local" }, true),
    ).toBe(false);
    expect(
      hostedDraftSession({ kind: "unavailable", source: "sandbox" }, true),
    ).toBe(false);
    expect(hostedDraftSession({ kind: "legacy" }, true)).toBe(false);
  });
});

describe("servePreviewUrl", () => {
  const local = (preview: { url: string } | null) =>
    ({
      kind: "protocol",
      source: "local",
      client: {},
      describe: { preview },
      cacheKeySuffix: "",
    }) as unknown as Parameters<typeof servePreviewUrl>[0];

  test("loads the app deco serve --preview names, on this machine", () => {
    expect(servePreviewUrl(local({ url: "http://localhost:8001" }))).toBe(
      "http://localhost:8001",
    );
    expect(servePreviewUrl(local({ url: "http://127.0.0.1:3000/en/" }))).toBe(
      "http://127.0.0.1:3000/en/",
    );
  });

  test("refuses a preview anywhere else", () => {
    for (const url of [
      "https://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://evil.test:80",
    ]) {
      expect(servePreviewUrl(local({ url }))).toBeNull();
    }
    expect(servePreviewUrl(local(null))).toBeNull();
  });

  test("only a local deco serve has one", () => {
    expect(servePreviewUrl({ kind: "legacy" })).toBeNull();
    expect(
      servePreviewUrl({
        ...local({ url: "http://localhost:8001" }),
        source: "github",
      } as Parameters<typeof servePreviewUrl>[0]),
    ).toBeNull();
  });
});

describe("newBlocksEditorEnabled", () => {
  const kinds = ["protocol", "unavailable", "legacy", "pending"] as const;

  test("a v8 site gets the new editor whatever the org flag says", () => {
    for (const backend of ["protocol", "unavailable"] as const) {
      for (const orgFlag of [true, false, undefined]) {
        expect(newBlocksEditorEnabled({ backend, hasOrg: true, orgFlag })).toBe(
          true,
        );
      }
    }
  });

  test("a v7 site follows the org flag, waiting while it loads", () => {
    for (const orgFlag of [true, false, undefined]) {
      expect(
        newBlocksEditorEnabled({ backend: "legacy", hasOrg: true, orgFlag }),
      ).toBe(orgFlag);
    }
  });

  test("outside a site the org flag alone decides", () => {
    for (const orgFlag of [true, false, undefined]) {
      expect(
        newBlocksEditorEnabled({ backend: null, hasOrg: true, orgFlag }),
      ).toBe(orgFlag);
    }
  });

  test("no org (/site-editor): v8 is on, and nothing waits on a flag", () => {
    for (const orgFlag of [true, false, undefined]) {
      expect(
        newBlocksEditorEnabled({ backend: "protocol", hasOrg: false, orgFlag }),
      ).toBe(true);
      expect(
        newBlocksEditorEnabled({
          backend: "unavailable",
          hasOrg: false,
          orgFlag,
        }),
      ).toBe(true);
      // A v7 site can't be reached without an org, but it wouldn't hang.
      expect(
        newBlocksEditorEnabled({ backend: "legacy", hasOrg: false, orgFlag }),
      ).toBe(false);
    }
  });

  test("while the version is detected it waits, unless the flag is on", () => {
    expect(
      newBlocksEditorEnabled({
        backend: "pending",
        hasOrg: true,
        orgFlag: true,
      }),
    ).toBe(true);
    for (const orgFlag of [false, undefined]) {
      expect(
        newBlocksEditorEnabled({ backend: "pending", hasOrg: true, orgFlag }),
      ).toBeUndefined();
    }
    expect(
      newBlocksEditorEnabled({
        backend: "pending",
        hasOrg: false,
        orgFlag: undefined,
      }),
    ).toBeUndefined();
  });

  test("never the old editor for a site that may be v8", () => {
    for (const backend of kinds) {
      const decided = newBlocksEditorEnabled({
        backend,
        hasOrg: false,
        orgFlag: undefined,
      });
      if (backend !== "legacy") expect(decided).not.toBe(false);
    }
  });
});

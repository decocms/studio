import { describe, expect, test } from "bun:test";
import {
  blockKeysOfWrite,
  contentProbesEnabled,
  hostedCmsAvailable,
  isProtocolProject,
  isV8Schema,
  mergePolledBlocks,
  newBlocksEditorEnabled,
  selectContentBackend,
  serveAssetUploadOrigin,
  servePreviewUrl,
} from "./content-backend";

describe("selectContentBackend", () => {
  const v8 = {
    hasProject: true,
    isV8Project: true,
    flagEnabled: true,
    hasServeConnection: false,
    runtime: "cms" as const,
    githubSite: "v8" as const,
  };
  const v7 = { ...v8, isV8Project: false, githubSite: "v7" as const };
  const SITES = ["v8", "v7", "loading", "error"] as const;
  const SANDBOX_SITES = [...SITES, "unavailable", undefined] as const;
  const FLAGS = [true, false, undefined] as const;

  describe("v7 project (no marker): as on main", () => {
    test("is never pending, whatever the flag or the probes say", () => {
      for (const flagEnabled of FLAGS) {
        for (const runtime of ["cms", "sandbox"] as const) {
          for (const githubSite of SITES) {
            for (const sandboxSite of SANDBOX_SITES) {
              const decision = selectContentBackend({
                ...v7,
                flagEnabled,
                runtime,
                githubSite,
                sandboxSite,
              });
              expect(decision).not.toBe("pending");
            }
          }
        }
      }
    });

    test("is always legacy, whatever the flag, the probes or a stored connection say", () => {
      for (const flagEnabled of FLAGS) {
        for (const runtime of ["cms", "sandbox"] as const) {
          for (const githubSite of SITES) {
            for (const sandboxSite of SANDBOX_SITES) {
              for (const hasServeConnection of [true, false]) {
                expect(
                  selectContentBackend({
                    ...v7,
                    flagEnabled,
                    runtime,
                    githubSite,
                    sandboxSite,
                    hasServeConnection,
                  }),
                ).toBe("legacy");
              }
            }
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
      for (const flagEnabled of FLAGS) {
        for (const runtime of ["cms", "sandbox"] as const) {
          for (const hasServeConnection of [true, false]) {
            expect(
              contentProbesEnabled({
                isV8Project: false,
                flagEnabled,
                hasServeConnection,
                runtime,
                workingTreeReady: true,
              }),
            ).toEqual({ github: false, sandbox: false });
          }
        }
      }
    });
  });

  describe("v8 project (marker)", () => {
    test("Localhost (a connected deco serve) wins over everything", () => {
      for (const flagEnabled of FLAGS) {
        expect(
          selectContentBackend({
            ...v8,
            flagEnabled,
            hasServeConnection: true,
            runtime: "sandbox",
            githubSite: "v7",
          }),
        ).toBe("protocol-local");
      }
    });

    test("a cms session waits for the flag and the GitHub probe (the hosted draft)", () => {
      expect(selectContentBackend({ ...v8, flagEnabled: undefined })).toBe(
        "pending",
      );
      expect(selectContentBackend({ ...v8, githubSite: "loading" })).toBe(
        "pending",
      );
      expect(selectContentBackend(v8)).toBe("protocol-github");
    });

    test("a v7 answer or the flag off fall back to legacy", () => {
      expect(selectContentBackend({ ...v8, githubSite: "v7" })).toBe("legacy");
      expect(selectContentBackend({ ...v8, flagEnabled: false })).toBe(
        "legacy",
      );
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

    test("probes only behind the flag, and not while Localhost is connected", () => {
      const input = {
        isV8Project: true,
        flagEnabled: true,
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
      for (const flagEnabled of [false, undefined]) {
        expect(contentProbesEnabled({ ...input, flagEnabled })).toEqual({
          github: false,
          sandbox: false,
        });
      }
      expect(
        contentProbesEnabled({ ...input, hasServeConnection: true }),
      ).toEqual({ github: false, sandbox: false });
    });
  });

  test("without a project (SEO, blog forms) it is legacy right away", () => {
    for (const isV8Project of [true, false]) {
      for (const flagEnabled of FLAGS) {
        expect(
          selectContentBackend({
            ...v8,
            isV8Project,
            hasProject: false,
            flagEnabled,
            githubSite: "loading",
          }),
        ).toBe("legacy");
      }
    }
  });
});

describe("hostedCmsAvailable", () => {
  test("Versions and Site tokens: v8 sites behind the flag; never v7, never waiting", () => {
    expect(hostedCmsAvailable(true, true)).toBe(true);
    expect(hostedCmsAvailable(false, true)).toBe(false);
    expect(hostedCmsAvailable(undefined, true)).toBeUndefined();
    for (const flag of [true, false, undefined]) {
      expect(hostedCmsAvailable(flag, false)).toBe(false);
    }
  });
});

describe("isV8Schema", () => {
  test('only "blocksMajor": 8 is v8', () => {
    expect(isV8Schema({ major: 1, blocksMajor: 8 })).toBe(true);
  });

  test("a missing field or any other value is v7", () => {
    for (const schema of [
      { major: 1 },
      { major: 1, blocksMajor: 7 },
      { major: 1, blocksMajor: "8" },
      { major: 1, blocksMajor: null },
      { major: 1, blocksMajor: 9 },
      null,
      undefined,
      "8",
      8,
    ]) {
      expect(isV8Schema(schema)).toBe(false);
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

describe("serveAssetUploadOrigin", () => {
  const assets = { dir: "public/assets", urlPrefix: "/assets/", maxBytes: 1 };
  const protocol = (
    source: "github" | "local" | "sandbox",
    describeAssets: typeof assets | null = assets,
  ) =>
    ({
      kind: "protocol",
      source,
      client: {},
      describe: { assets: describeAssets },
      cacheKeySuffix: "",
    }) as unknown as Parameters<typeof serveAssetUploadOrigin>[0];
  const serve = { endpoint: "http://localhost:4000/rpc" };

  test("Localhost and /site-editor (a connected deco serve) upload to it", () => {
    expect(serveAssetUploadOrigin(protocol("local"), serve)).toBe(
      "http://localhost:4000",
    );
  });

  test("hosted and sandbox projects upload to Studio's file storage", () => {
    // Even a daemon or storage that still advertised an upload folder.
    expect(serveAssetUploadOrigin(protocol("sandbox"), serve)).toBeNull();
    expect(serveAssetUploadOrigin(protocol("github"), serve)).toBeNull();
    expect(serveAssetUploadOrigin(protocol("sandbox", null), null)).toBeNull();
    expect(serveAssetUploadOrigin({ kind: "legacy" }, serve)).toBeNull();
  });

  test("a deco serve that is gone or read-only for uploads takes none", () => {
    expect(serveAssetUploadOrigin(protocol("local"), null)).toBeNull();
    expect(serveAssetUploadOrigin(protocol("local", null), serve)).toBeNull();
  });
});

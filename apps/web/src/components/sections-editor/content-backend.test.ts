import { describe, expect, test } from "bun:test";
import {
  blockKeysOfWrite,
  contentMode,
  decisionKind,
  contentProbesEnabled,
  hostedDraftSession,
  isProtocolProject,
  mergePolledBlocks,
  newBlocksEditorEnabled,
  readFailed,
  selectContentBackend,
  serveAssetUploadOrigin,
  servePreviewUrl,
} from "./content-backend";

type Input = Parameters<typeof selectContentBackend>[0];
const PROBES = ["ready", "loading", "error"] as const;
const MODES = {
  github: { hasServeConnection: false, runtime: "cms" },
  sandbox: { hasServeConnection: false, runtime: "sandbox" },
  local: { hasServeConnection: true, runtime: "cms" },
} as const;

describe("selectContentBackend: the Blocks v8 site switch decides, in every mode", () => {
  const github: Input = {
    hasProject: true,
    ...MODES.github,
    v8: true,
    githubSite: "ready",
  };
  const sandbox: Input = {
    ...github,
    ...MODES.sandbox,
    githubSite: "loading",
    sandboxSite: "ready",
  };
  const local: Input = { ...github, ...MODES.local, githubSite: "loading" };

  describe("the decision table (mode × switch × backend)", () => {
    const table: Array<[string, Input, string]> = [
      // GitHub mode.
      ["github, off", { ...github, v8: false }, "legacy"],
      [
        "github, on, backend loading",
        { ...github, githubSite: "loading" },
        "pending",
      ],
      ["github, on, backend ready", github, "protocol-github"],
      [
        "github, on, backend failing",
        { ...github, githubSite: "error" },
        "unavailable-github",
      ],
      [
        "github, on, not this project's site",
        { ...github, githubSite: "not-owned" },
        "site-not-owned-github",
      ],
      // Sandbox mode.
      ["sandbox, off", { ...sandbox, v8: false }, "legacy"],
      [
        "sandbox, on, booting",
        { ...sandbox, sandboxSite: "unavailable" },
        "pending",
      ],
      [
        "sandbox, on, loading",
        { ...sandbox, sandboxSite: "loading" },
        "pending",
      ],
      ["sandbox, on, ready", sandbox, "protocol-sandbox"],
      [
        "sandbox, on, failing before any answer (retried)",
        { ...sandbox, sandboxSite: "error" },
        "retrying-sandbox",
      ],
      // Localhost: a connection exists only on a v8 project (see
      // useDecoServeConnection), and then it wins.
      ["localhost, on", local, "protocol-local"],
    ];
    for (const [name, input, expected] of table) {
      test(`${name} → ${expected}`, () => {
        expect(selectContentBackend(input)).toBe(expected as never);
      });
    }
  });

  test("off (v7): legacy in GitHub and Sandbox mode whatever the backends say", () => {
    for (const mode of ["github", "sandbox"] as const) {
      for (const githubSite of [...PROBES, "not-owned"] as const) {
        for (const sandboxSite of [...PROBES, "unavailable"] as const) {
          expect(
            selectContentBackend({
              hasProject: true,
              ...MODES[mode],
              v8: false,
              githubSite,
              sandboxSite,
            }),
          ).toBe("legacy");
        }
      }
    }
  });

  test("on (v8): never legacy in any mode, whatever the backends say", () => {
    for (const mode of ["github", "sandbox", "local"] as const) {
      for (const githubSite of [...PROBES, "not-owned"] as const) {
        for (const sandboxSite of [...PROBES, "unavailable"] as const) {
          expect(
            selectContentBackend({
              hasProject: true,
              ...MODES[mode],
              v8: true,
              githubSite,
              sandboxSite,
            }),
          ).not.toBe("legacy");
        }
      }
    }
  });

  test("Sandbox mode never reads the hosted backend, GitHub mode never the sandbox", () => {
    for (const githubSite of [...PROBES, "not-owned"] as const) {
      expect(selectContentBackend({ ...sandbox, githubSite })).toBe(
        "protocol-sandbox",
      );
    }
    for (const sandboxSite of [...PROBES, "unavailable"] as const) {
      expect(selectContentBackend({ ...github, sandboxSite })).toBe(
        "protocol-github",
      );
    }
  });

  test("no v7 flash: a v8 project goes from pending to its backend, never through legacy", () => {
    expect(
      (["loading", "error", "ready"] as const).map((githubSite) =>
        selectContentBackend({ ...github, githubSite }),
      ),
    ).toEqual(["pending", "unavailable-github", "protocol-github"]);
    expect(
      (["unavailable", "loading", "error", "ready"] as const).map(
        (sandboxSite) => selectContentBackend({ ...sandbox, sandboxSite }),
      ),
    ).toEqual(["pending", "pending", "retrying-sandbox", "protocol-sandbox"]);
    // What the editor shows while pending is never the v7 editor.
    for (const d of ["pending", "retrying-sandbox"] as const) {
      expect(decisionKind(d)).toBe("pending");
      expect(
        newBlocksEditorEnabled({
          backend: decisionKind(d),
          hasOrg: true,
          orgFlag: false,
        }),
      ).toBe(true);
    }
  });

  test("the probes: only on a v8 project, the one its mode reads", () => {
    const probes = (
      mode: "github" | "sandbox" | "local",
      v8: boolean,
      workingTreeReady = true,
    ) => contentProbesEnabled({ mode, v8, workingTreeReady });
    expect(probes("github", true)).toEqual({ github: true, sandbox: false });
    expect(probes("sandbox", true)).toEqual({ github: false, sandbox: true });
    expect(probes("sandbox", true, false)).toEqual({
      github: false,
      sandbox: false,
    });
    expect(probes("local", true)).toEqual({ github: false, sandbox: false });
    // v7 probes nothing, as on main.
    for (const mode of ["github", "sandbox", "local"] as const) {
      expect(probes(mode, false)).toEqual({ github: false, sandbox: false });
    }
  });

  test("the mode: Localhost, else Sandbox for a sandbox session, else GitHub", () => {
    expect(contentMode({ hasServeConnection: true, runtime: "sandbox" })).toBe(
      "local",
    );
    expect(contentMode({ hasServeConnection: false, runtime: "sandbox" })).toBe(
      "sandbox",
    );
    expect(contentMode({ hasServeConnection: false, runtime: "cms" })).toBe(
      "github",
    );
  });

  test("the account-less /site-editor (no project switch): its own deco serve", () => {
    expect(selectContentBackend({ ...local, v8: false })).toBe(
      "protocol-local",
    );
  });

  test("without a project (SEO, blog forms) it is legacy right away", () => {
    for (const v8 of [true, false]) {
      for (const hasServeConnection of [true, false]) {
        expect(
          selectContentBackend({
            ...github,
            v8,
            hasServeConnection,
            hasProject: false,
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

  test("GitHub mode on a v8 project, usable, unreachable or still connecting", () => {
    expect(hostedDraftSession(protocol("github"), "github", true)).toBe(true);
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "github" },
        "github",
        true,
      ),
    ).toBe(true);
    expect(hostedDraftSession({ kind: "pending" }, "github", true)).toBe(true);
  });

  test("never a v7 project (the switch off)", () => {
    expect(hostedDraftSession({ kind: "legacy" }, "github", false)).toBe(false);
    expect(hostedDraftSession({ kind: "pending" }, "github", false)).toBe(
      false,
    );
    expect(hostedDraftSession(protocol("github"), "github", false)).toBe(false);
  });

  test("not Localhost or a sandbox (a sandbox session boots, v8 or not)", () => {
    for (const mode of ["local", "sandbox"] as const) {
      expect(hostedDraftSession({ kind: "pending" }, mode, true)).toBe(false);
    }
    expect(hostedDraftSession(protocol("local"), "local", true)).toBe(false);
    expect(hostedDraftSession(protocol("sandbox"), "sandbox", true)).toBe(
      false,
    );
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "local" },
        "local",
        true,
      ),
    ).toBe(false);
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "sandbox" },
        "sandbox",
        true,
      ),
    ).toBe(false);
    expect(hostedDraftSession({ kind: "legacy" }, "github", true)).toBe(false);
  });

  test("not a v8 site another project owns (its draft lives there)", () => {
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "github", siteNotOwned: true },
        "github",
        true,
      ),
    ).toBe(false);
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

  test("a v8 project gets the new editor whatever the org flag says", () => {
    for (const backend of ["protocol", "unavailable", "pending"] as const) {
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

  test("a v8 project still connecting (pending) gets the new editor at once", () => {
    for (const hasOrg of [true, false]) {
      for (const orgFlag of [true, false, undefined]) {
        expect(
          newBlocksEditorEnabled({ backend: "pending", hasOrg, orgFlag }),
        ).toBe(true);
      }
    }
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

describe("readFailed", () => {
  test("a failed read stays failed while it is re-polled, until it succeeds", () => {
    expect(readFailed({ isError: false, errorUpdateCount: 0 })).toBe(false);
    expect(readFailed({ isError: true, errorUpdateCount: 1 })).toBe(true);
    // Re-polling: the query is back to `pending` with no data.
    expect(readFailed({ isError: false, errorUpdateCount: 1 })).toBe(true);
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
    // Even a storage that still advertised an upload folder.
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

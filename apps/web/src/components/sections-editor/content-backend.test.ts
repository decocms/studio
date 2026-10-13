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
  servePreviewUrl,
} from "./content-backend";

type Input = Parameters<typeof selectContentBackend>[0];
type Answer = "v8" | "v7" | "loading" | "error";
const ANSWERS = ["v8", "v7", "loading", "error"] as const;

describe("selectContentBackend: the editor waits for a schema, then reads it", () => {
  const github: Input = {
    hasProject: true,
    hasServeConnection: false,
    runtime: "cms",
    mainSchema: "v8",
    githubSite: "v8",
  };
  const sandbox: Input = {
    ...github,
    runtime: "sandbox",
    githubSite: "loading",
    sandboxSite: "v8",
    // A project the server last found v8 (its marker): a failing daemon waits.
    markedV8: true,
  };

  describe("the decision table (mode × schema)", () => {
    const table: Array<[string, Input, string]> = [
      // GitHub mode: main's schema (from the server) decides.
      ["github, main loading", { ...github, mainSchema: "loading" }, "pending"],
      [
        "github, main v7",
        { ...github, mainSchema: "v7", githubSite: "loading" },
        "legacy",
      ],
      [
        "github, main last found v8, unreadable (undecided, retried)",
        { ...github, mainSchema: "error" },
        "retrying-github",
      ],
      [
        "github, main v8, backend loading",
        { ...github, githubSite: "loading" },
        "pending",
      ],
      ["github, main v8, backend v8", github, "protocol-github"],
      [
        "github, main v8, backend failing",
        { ...github, githubSite: "error" },
        "unavailable-github",
      ],
      [
        "github, main v8, not this project's site",
        { ...github, githubSite: "not-owned" },
        "site-not-owned-github",
      ],
      // Sandbox mode: the daemon's working tree decides; main plays no part.
      [
        "sandbox, booting",
        { ...sandbox, sandboxSite: "unavailable" },
        "pending",
      ],
      [
        "sandbox, daemon loading",
        { ...sandbox, sandboxSite: "loading" },
        "pending",
      ],
      ["sandbox, working tree v8", sandbox, "protocol-sandbox"],
      [
        "sandbox, working tree v7 (or an older daemon)",
        { ...sandbox, sandboxSite: "v7" },
        "legacy",
      ],
      [
        "sandbox, daemon failing before any answer (undecided, retried)",
        { ...sandbox, sandboxSite: "error" },
        "retrying-sandbox",
      ],
      [
        "sandbox, daemon failing before any answer, project not marked v8 (the v7 sandbox editor, as on main)",
        { ...sandbox, sandboxSite: "error", markedV8: false },
        "legacy",
      ],
      [
        "sandbox, booting, project not marked v8 (waits for the working tree, as main's reads did)",
        { ...sandbox, sandboxSite: "unavailable", markedV8: false },
        "pending",
      ],
      // Localhost: the deco serve's own schema decides (localServeBackend).
      [
        "localhost",
        { ...github, hasServeConnection: true, mainSchema: "loading" },
        "protocol-local",
      ],
      [
        "localhost chosen, main's answer loading",
        { ...github, serveConnectionUndecided: true },
        "pending",
      ],
    ];
    for (const [name, input, expected] of table) {
      test(`${name} → ${expected}`, () => {
        expect(selectContentBackend(input)).toBe(expected as never);
      });
    }
  });

  test("Sandbox mode never reads main's answer", () => {
    for (const mainSchema of ANSWERS) {
      for (const sandboxSite of [...ANSWERS, "unavailable"] as const) {
        expect(
          selectContentBackend({ ...sandbox, mainSchema, sandboxSite }),
        ).toBe(
          selectContentBackend({ ...sandbox, mainSchema: "v8", sandboxSite }),
        );
      }
    }
  });

  test("Localhost wins in every mode, whatever main says", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      for (const mainSchema of ANSWERS) {
        expect(
          selectContentBackend({
            ...github,
            runtime,
            mainSchema,
            hasServeConnection: true,
          }),
        ).toBe("protocol-local");
      }
    }
  });

  test("a v7 site in GitHub mode is legacy whatever the branch says, and probes nothing", () => {
    for (const githubSite of [...ANSWERS, "not-owned"] as const) {
      expect(
        selectContentBackend({ ...github, mainSchema: "v7", githubSite }),
      ).toBe("legacy");
    }
    expect(
      contentProbesEnabled({
        mode: "github",
        mainSchema: "v7",
        workingTreeReady: true,
      }),
    ).toEqual({ github: false, sandbox: false });
  });

  describe("no v7 flash: once decided, it never switches as reads land", () => {
    // Every order in which the reads of a mode can land, from nothing known
    // to everything known: the decision goes from `pending` (or an
    // `unavailable` retry) to its final answer, never from one editor to the
    // other.
    // `unavailable-*` is the v8 editor's retrying state: a v8 editor.
    const EDITORS: Record<string, "v7" | "v8"> = {
      legacy: "v7",
      "protocol-github": "v8",
      "protocol-sandbox": "v8",
      "unavailable-github": "v8",
    };
    /** What the editor shows for a decision, as the editor reads it. */
    function shows(decision: ReturnType<typeof selectContentBackend>) {
      const kind = decisionKind(decision);
      const backend =
        kind === "pending"
          ? ({ kind } as const)
          : kind === "legacy"
            ? ({ kind } as const)
            : ({ kind: "unavailable", source: "github" } as const);
      return {
        protocol: isProtocolProject(backend),
        // The org flag off: v7 must never get the new editor.
        newEditor: newBlocksEditorEnabled({
          backend: kind,
          hasOrg: true,
          orgFlag: false,
        }),
      };
    }
    function assertNoSwitch(steps: Input[]) {
      const decisions = steps.map((step) => selectContentBackend(step));
      const editors = decisions.flatMap((d) => EDITORS[d] ?? []);
      expect(new Set(editors).size).toBeLessThanOrEqual(1);
      // What the editor shows: once it shows a generation (protocol or not,
      // new editor or not), it never shows the other one.
      const seen = decisions
        .map(shows)
        .filter((s) => s.newEditor !== undefined);
      expect(new Set(seen.map((s) => s.protocol)).size).toBeLessThanOrEqual(1);
      expect(new Set(seen.map((s) => s.newEditor)).size).toBeLessThanOrEqual(1);
      return decisions;
    }

    test("GitHub, a main last found v8 that can't be read, then turned v7: undecided, then legacy, never v8-looking", () => {
      const decisions = assertNoSwitch([
        { ...github, mainSchema: "loading", githubSite: "loading" },
        { ...github, mainSchema: "error", githubSite: "loading" },
        { ...github, mainSchema: "error", githubSite: "loading" },
        { ...github, mainSchema: "v7", githubSite: "loading" },
      ]);
      expect(decisions).toEqual([
        "pending",
        "retrying-github",
        "retrying-github",
        "legacy",
      ]);
      for (const d of decisions.slice(0, 3)) {
        expect(shows(d)).toEqual({ protocol: false, newEditor: undefined });
      }
    });

    test("Sandbox, a daemon failing before it answered: undecided, then its answer", () => {
      for (const final of ["v8", "v7"] as const) {
        const decisions = assertNoSwitch([
          { ...sandbox, sandboxSite: "loading" },
          { ...sandbox, sandboxSite: "error" },
          { ...sandbox, sandboxSite: final },
        ]);
        expect(decisions.slice(0, 2)).toEqual(["pending", "retrying-sandbox"]);
        expect(shows(decisions[1]!).protocol).toBe(false);
      }
    });

    test("Sandbox, an unmarked project whose daemon fails before it answered: the v7 sandbox editor, as on main; a later v8 answer takes over", () => {
      const unmarked = { ...sandbox, markedV8: false };
      expect(
        [
          { ...unmarked, sandboxSite: "unavailable" as const },
          { ...unmarked, sandboxSite: "loading" as const },
          { ...unmarked, sandboxSite: "error" as const },
          { ...unmarked, sandboxSite: "error" as const },
          { ...unmarked, sandboxSite: "v7" as const },
        ].map(selectContentBackend),
      ).toEqual(["pending", "pending", "legacy", "legacy", "legacy"]);
      expect(selectContentBackend({ ...unmarked, sandboxSite: "v8" })).toBe(
        "protocol-sandbox",
      );
    });

    test("the marker never makes a project v8 on its own", () => {
      for (const sandboxSite of ["v7", "loading", "unavailable"] as const) {
        expect(
          selectContentBackend({ ...sandbox, sandboxSite, markedV8: true }),
        ).not.toBe("protocol-sandbox");
      }
      for (const mainSchema of ["v7", "loading", "error"] as const) {
        expect(
          selectContentBackend({ ...github, mainSchema, markedV8: true }),
        ).not.toBe("protocol-github");
      }
    });

    test("an unreadable schema is never a protocol project nor the new editor (flag off)", () => {
      for (const d of [
        selectContentBackend({ ...github, mainSchema: "error" }),
        selectContentBackend({ ...sandbox, sandboxSite: "error" }),
      ]) {
        expect(shows(d)).toEqual({ protocol: false, newEditor: undefined });
      }
    });

    test("GitHub, v8 main: pending until the backend answers, never legacy", () => {
      const decisions = assertNoSwitch([
        { ...github, mainSchema: "loading", githubSite: "loading" },
        { ...github, mainSchema: "v8", githubSite: "loading" },
        { ...github, mainSchema: "v8", githubSite: "v8" },
      ]);
      expect(decisions).toEqual(["pending", "pending", "protocol-github"]);
    });

    test("GitHub, v7 main: pending, then legacy (as on main)", () => {
      const decisions = assertNoSwitch([
        { ...github, mainSchema: "loading", githubSite: "loading" },
        { ...github, mainSchema: "v7", githubSite: "loading" },
      ]);
      expect(decisions).toEqual(["pending", "legacy"]);
    });

    test("Sandbox: pending while it boots, then the working tree's answer", () => {
      for (const final of ["v8", "v7"] as const) {
        const decisions = assertNoSwitch([
          { ...sandbox, sandboxSite: "unavailable" },
          { ...sandbox, sandboxSite: "loading" },
          { ...sandbox, sandboxSite: final },
        ]);
        expect(decisions.slice(0, 2)).toEqual(["pending", "pending"]);
      }
    });

    test("a stored Localhost choice waits for main, never another backend first", () => {
      const decisions = assertNoSwitch([
        { ...github, mainSchema: "loading", serveConnectionUndecided: true },
        { ...github, mainSchema: "v8", hasServeConnection: true },
      ]);
      expect(decisions).toEqual(["pending", "protocol-local"]);
    });

    test("every answer that isn't known yet is pending, in every mode", () => {
      expect(selectContentBackend({ ...github, mainSchema: "loading" })).toBe(
        "pending",
      );
      expect(selectContentBackend({ ...sandbox, sandboxSite: "loading" })).toBe(
        "pending",
      );
      expect(
        selectContentBackend({ ...github, serveConnectionUndecided: true }),
      ).toBe("pending");
    });
  });

  test("the probes: the daemon in Sandbox mode, the GitHub backend only for a v8 main", () => {
    const probes = (
      mode: "github" | "sandbox" | "local",
      mainSchema: Answer,
      workingTreeReady = true,
    ) => contentProbesEnabled({ mode, mainSchema, workingTreeReady });
    expect(probes("github", "v8")).toEqual({ github: true, sandbox: false });
    for (const main of ["v7", "loading", "error"] as const) {
      expect(probes("github", main)).toEqual({ github: false, sandbox: false });
    }
    for (const main of ANSWERS) {
      expect(probes("sandbox", main)).toEqual({ github: false, sandbox: true });
      expect(probes("sandbox", main, false)).toEqual({
        github: false,
        sandbox: false,
      });
      expect(probes("local", main)).toEqual({ github: false, sandbox: false });
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

  test("the account-less /site-editor: only its deco serve, whose schema decides", () => {
    expect(
      selectContentBackend({
        ...github,
        mainSchema: "v7",
        hasServeConnection: true,
      }),
    ).toBe("protocol-local");
  });

  test("without a project (SEO, blog forms) it is legacy right away", () => {
    for (const mainSchema of ANSWERS) {
      for (const hasServeConnection of [true, false]) {
        expect(
          selectContentBackend({
            ...github,
            mainSchema,
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

  test("GitHub mode on a v8 main, usable, unreachable or still deciding", () => {
    expect(hostedDraftSession(protocol("github"), "github", "v8")).toBe(true);
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "github" },
        "github",
        "v8",
      ),
    ).toBe(true);
    expect(hostedDraftSession({ kind: "pending" }, "github", "v8")).toBe(true);
  });

  test("never a v7 site, nor while main's answer is unknown", () => {
    for (const main of ["v7", "loading", "error"] as const) {
      expect(hostedDraftSession({ kind: "legacy" }, "github", main)).toBe(
        false,
      );
      expect(hostedDraftSession({ kind: "pending" }, "github", main)).toBe(
        false,
      );
      expect(hostedDraftSession(protocol("github"), "github", main)).toBe(
        false,
      );
    }
  });

  test("not Localhost or a sandbox (a sandbox session boots, v8 or not)", () => {
    for (const mode of ["local", "sandbox"] as const) {
      expect(hostedDraftSession({ kind: "pending" }, mode, "v8")).toBe(false);
    }
    expect(hostedDraftSession(protocol("local"), "local", "v8")).toBe(false);
    expect(hostedDraftSession(protocol("sandbox"), "sandbox", "v8")).toBe(
      false,
    );
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "local" },
        "local",
        "v8",
      ),
    ).toBe(false);
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "sandbox" },
        "sandbox",
        "v8",
      ),
    ).toBe(false);
    expect(hostedDraftSession({ kind: "legacy" }, "github", "v8")).toBe(false);
  });

  test("not a v8 site another project owns (its draft lives there)", () => {
    expect(
      hostedDraftSession(
        { kind: "unavailable", source: "github", siteNotOwned: true },
        "github",
        "v8",
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

describe("readFailed", () => {
  test("a failed read stays failed while it is re-polled, until it succeeds", () => {
    expect(readFailed({ isError: false, errorUpdateCount: 0 })).toBe(false);
    expect(readFailed({ isError: true, errorUpdateCount: 1 })).toBe(true);
    // Re-polling: the query is back to `pending` with no data.
    expect(readFailed({ isError: false, errorUpdateCount: 1 })).toBe(true);
  });
});

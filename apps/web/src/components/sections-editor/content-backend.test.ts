import { describe, expect, test } from "bun:test";
import {
  blockKeysOfWrite,
  isProtocolProject,
  isV8Schema,
  mergePolledBlocks,
  newBlocksEditorEnabled,
  selectContentBackend,
  servePreviewUrl,
} from "./content-backend";

describe("selectContentBackend", () => {
  const base = {
    hasProject: true,
    flagEnabled: true,
    hasServeConnection: false,
    hasLocalTunnel: false,
    runtime: "cms" as const,
    githubSite: "v8" as const,
  };

  test("waits for the org flag before the GitHub backend", () => {
    expect(selectContentBackend({ ...base, flagEnabled: undefined })).toBe(
      "pending",
    );
    // The tunnel and sandbox sessions don't need the flag to be known.
    expect(
      selectContentBackend({
        ...base,
        flagEnabled: undefined,
        hasLocalTunnel: true,
      }),
    ).toBe("legacy");
  });

  test("the flag off keeps the GitHub backend legacy", () => {
    expect(selectContentBackend({ ...base, flagEnabled: false })).toBe(
      "legacy",
    );
  });

  test("a connected deco serve needs no flag", () => {
    for (const flagEnabled of [false, undefined]) {
      expect(
        selectContentBackend({
          ...base,
          flagEnabled,
          hasServeConnection: true,
        }),
      ).toBe("protocol-local");
    }
  });

  test("a connected deco serve wins, over the tunnel and any runtime", () => {
    expect(
      selectContentBackend({
        ...base,
        hasServeConnection: true,
        hasLocalTunnel: true,
        runtime: "sandbox",
        githubSite: "v7",
      }),
    ).toBe("protocol-local");
  });

  test("the legacy tunnel and sandbox sessions stay legacy", () => {
    expect(selectContentBackend({ ...base, hasLocalTunnel: true })).toBe(
      "legacy",
    );
    expect(selectContentBackend({ ...base, runtime: "sandbox" })).toBe(
      "legacy",
    );
  });

  test("a cms session follows the committed schema's blocksMajor", () => {
    expect(selectContentBackend(base)).toBe("protocol-github");
    expect(selectContentBackend({ ...base, githubSite: "v7" })).toBe("legacy");
    expect(selectContentBackend({ ...base, githubSite: "loading" })).toBe(
      "pending",
    );
  });

  test("a failed GitHub probe is v7, never unavailable", () => {
    expect(selectContentBackend({ ...base, githubSite: "error" })).toBe(
      "legacy",
    );
  });

  test("without a project (SEO, blog forms) it is legacy right away", () => {
    for (const flagEnabled of [true, false, undefined]) {
      expect(
        selectContentBackend({
          ...base,
          hasProject: false,
          flagEnabled,
          githubSite: "loading",
        }),
      ).toBe("legacy");
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

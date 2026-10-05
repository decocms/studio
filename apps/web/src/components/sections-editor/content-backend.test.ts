import { describe, expect, test } from "bun:test";
import {
  blockKeysOfWrite,
  isProtocolProject,
  mergePolledBlocks,
  selectContentBackend,
  servePreviewUrl,
} from "./content-backend";

describe("selectContentBackend", () => {
  const base = {
    flagEnabled: true,
    hasServeConnection: false,
    hasLocalTunnel: false,
    runtime: "cms" as const,
    githubSchema: "present" as const,
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
        githubSchema: "absent",
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

  test("a cms session follows the committed schema", () => {
    expect(selectContentBackend(base)).toBe("protocol-github");
    expect(selectContentBackend({ ...base, githubSchema: "absent" })).toBe(
      "legacy",
    );
    expect(selectContentBackend({ ...base, githubSchema: "loading" })).toBe(
      "pending",
    );
    // A failed probe never routes a protocol site to the legacy path.
    expect(selectContentBackend({ ...base, githubSchema: "error" })).toBe(
      "unavailable-github",
    );
  });
});

describe("isProtocolProject", () => {
  test("a protocol endpoint, usable or not", () => {
    expect(
      isProtocolProject({ kind: "unavailable", source: "local" }),
    ).toBe(true);
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

import { afterEach, describe, it, expect } from "bun:test";
import {
  declaredPackageManager,
  detectRepoRuntimeAnonymous,
  extractDevPort,
} from "./github-runtime-detect";

describe("extractDevPort", () => {
  it("extracts a valid port from a dev script", () => {
    expect(
      extractDevPort(
        JSON.stringify({ scripts: { dev: "PORT=3000 next dev" } }),
      ),
    ).toBe("3000");
  });

  it("extracts a valid port from a deno task", () => {
    expect(
      extractDevPort(JSON.stringify({ tasks: { dev: "deno run --port8000" } })),
    ).toBe("8000");
  });

  it("extracts a port from a space-separated --port flag", () => {
    expect(
      extractDevPort(
        JSON.stringify({ scripts: { dev: "vite dev --port 8812" } }),
      ),
    ).toBe("8812");
  });

  it("extracts a port from an equals-separated --port flag", () => {
    expect(
      extractDevPort(JSON.stringify({ scripts: { dev: "vite --port=8812" } })),
    ).toBe("8812");
  });

  it("drops an out-of-range 5-digit match instead of returning it", () => {
    expect(
      extractDevPort(
        JSON.stringify({ scripts: { dev: "PORT=99999 next dev" } }),
      ),
    ).toBeNull();
  });

  it("returns null when the script has no port", () => {
    expect(
      extractDevPort(JSON.stringify({ scripts: { dev: "next dev" } })),
    ).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractDevPort("not json")).toBeNull();
  });

  it("returns null for null content", () => {
    expect(extractDevPort(null)).toBeNull();
  });
});

describe("declaredPackageManager", () => {
  it("reads the package manager package.json names", () => {
    expect(declaredPackageManager('{"packageManager":"yarn@1.22.22"}')).toBe(
      "yarn",
    );
    expect(declaredPackageManager('{"packageManager":"pnpm@9.1.0+sha"}')).toBe(
      "pnpm",
    );
  });

  it("ignores a missing, unknown or malformed field", () => {
    expect(declaredPackageManager('{"name":"x"}')).toBeNull();
    expect(declaredPackageManager('{"packageManager":"deno@2"}')).toBeNull();
    expect(declaredPackageManager('{"packageManager":3}')).toBeNull();
    expect(declaredPackageManager("not json")).toBeNull();
    expect(declaredPackageManager(null)).toBeNull();
  });
});

describe("detectRepoRuntimeAnonymous", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A repo whose root holds `files`; `contents` are served base64. */
  function serveRepo(
    files: Record<string, string>,
    options: { rootStatus?: number } = {},
  ) {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = decodeURIComponent(
        String(input).split("/contents/")[1] ?? "",
      );
      requested.push(path);
      if (path === "") {
        if (options.rootStatus) {
          return new Response("{}", { status: options.rootStatus });
        }
        return Response.json(
          Object.keys(files).map((name) => ({ name, type: "file" })),
        );
      }
      const content = files[path];
      if (content === undefined) return new Response("{}", { status: 404 });
      return Response.json({
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
      });
    }) as typeof fetch;
    return requested;
  }

  it("prefers the package manager package.json declares over a lockfile", async () => {
    serveRepo({
      "bun.lock": "",
      "yarn.lock": "",
      "package.json": JSON.stringify({
        packageManager: "yarn@1.22.22",
        scripts: { dev: "next dev --port 4000" },
      }),
    });
    expect(await detectRepoRuntimeAnonymous("o", "r")).toEqual({
      packageManager: "yarn",
      devPort: "4000",
    });
  });

  it("falls back to the lockfile, then to bun for a bare package.json", async () => {
    serveRepo({ "pnpm-lock.yaml": "", "package.json": "{}" });
    expect((await detectRepoRuntimeAnonymous("o", "r"))?.packageManager).toBe(
      "pnpm",
    );
    serveRepo({ "package.json": "{}" });
    expect((await detectRepoRuntimeAnonymous("o", "r"))?.packageManager).toBe(
      "bun",
    );
  });

  it("detects deno without reading package.json", async () => {
    const requested = serveRepo({
      "deno.json": JSON.stringify({ tasks: { dev: "deno run --port 8000" } }),
      "package.json": "{}",
    });
    expect(await detectRepoRuntimeAnonymous("o", "r")).toEqual({
      packageManager: "deno",
      devPort: "8000",
    });
    expect(requested).not.toContain("package.json");
  });

  it("detects nothing when the root listing fails", async () => {
    serveRepo({ "yarn.lock": "" }, { rootStatus: 403 });
    expect(await detectRepoRuntimeAnonymous("o", "r")).toBeNull();
  });

  it("detects nothing in a repo without a package manager", async () => {
    serveRepo({ "README.md": "" });
    expect(await detectRepoRuntimeAnonymous("o", "r")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  defaultThreadRuntime,
  fastPreviewCapability,
  isBlocksV8Project,
  parseThreadRuntime,
  readThreadRuntime,
} from "./session-runtime.ts";

const FP_PROJECT = {
  fastPreview: true,
  previewServerUrl: "https://acme.com",
};

describe("fastPreviewCapability", () => {
  test("needs both the flag and a URL", () => {
    expect(fastPreviewCapability(FP_PROJECT)).toBe(true);
    expect(fastPreviewCapability({ fastPreview: true })).toBe(false);
    expect(
      fastPreviewCapability({ previewServerUrl: "https://acme.com" }),
    ).toBe(false);
  });

  test("honors the legacy productionUrl key", () => {
    expect(
      fastPreviewCapability({
        fastPreview: true,
        productionUrl: "https://legacy.acme.com",
      }),
    ).toBe(true);
  });

  test("no other project metadata enters the predicate", () => {
    const withRepo = { ...FP_PROJECT, repository: { owner: "acme" } };
    const withoutRepo = { ...FP_PROJECT };
    expect(fastPreviewCapability(withRepo)).toBe(true);
    expect(fastPreviewCapability(withoutRepo)).toBe(true);
  });

  test("null / undefined metadata is not capable", () => {
    expect(fastPreviewCapability(null)).toBe(false);
    expect(fastPreviewCapability(undefined)).toBe(false);
  });
});

describe("defaultThreadRuntime", () => {
  test("capable project defaults new threads to cms", () => {
    expect(defaultThreadRuntime(FP_PROJECT)).toBe("cms");
  });

  test("everything else defaults to sandbox", () => {
    expect(defaultThreadRuntime({ fastPreview: true })).toBe("sandbox");
    expect(defaultThreadRuntime({ previewServerUrl: "https://acme.com" })).toBe(
      "sandbox",
    );
    expect(defaultThreadRuntime({})).toBe("sandbox");
    expect(defaultThreadRuntime(null)).toBe("sandbox");
  });
});

describe("readThreadRuntime", () => {
  test("the stamp decides, whatever the project says", () => {
    expect(readThreadRuntime({ runtime: "sandbox" }, FP_PROJECT)).toBe(
      "sandbox",
    );
    expect(readThreadRuntime({ runtime: "cms" }, FP_PROJECT)).toBe("cms");
  });

  // Inverted: the old resolver collapsed a `cms` stamp on a capability-less project into `sandbox`.
  test("a cms stamp survives a project with no capability", () => {
    expect(readThreadRuntime({ runtime: "cms" }, {})).toBe("cms");
    expect(readThreadRuntime({ runtime: "cms" }, null)).toBe("cms");
    expect(readThreadRuntime({ runtime: "cms" }, { fastPreview: true })).toBe(
      "cms",
    );
  });

  test("an unstamped thread falls back to the project default", () => {
    expect(readThreadRuntime({}, FP_PROJECT)).toBe("cms");
    expect(readThreadRuntime(null, FP_PROJECT)).toBe("cms");
    expect(readThreadRuntime(undefined, FP_PROJECT)).toBe("cms");
    expect(readThreadRuntime({}, {})).toBe("sandbox");
  });

  test("a garbage stamp is not a stamp", () => {
    expect(readThreadRuntime({ runtime: "SANDBOX" }, FP_PROJECT)).toBe("cms");
    expect(readThreadRuntime({ runtime: 1 }, FP_PROJECT)).toBe("cms");
    expect(readThreadRuntime({ runtime: "weird" }, {})).toBe("sandbox");
  });

  test("the unstamped fallback IS the creation default", () => {
    for (const meta of [
      FP_PROJECT,
      { fastPreview: true },
      { previewServerUrl: "https://acme.com" },
      {},
      null,
    ]) {
      expect(readThreadRuntime({}, meta)).toBe(defaultThreadRuntime(meta));
    }
  });
});

describe("parseThreadRuntime", () => {
  test("accepts only the two runtimes", () => {
    expect(parseThreadRuntime("cms")).toBe("cms");
    expect(parseThreadRuntime("sandbox")).toBe("sandbox");
    expect(parseThreadRuntime("Sandbox")).toBeNull();
    expect(parseThreadRuntime(undefined)).toBeNull();
    expect(parseThreadRuntime(null)).toBeNull();
    expect(parseThreadRuntime(true)).toBeNull();
  });
});

describe("isBlocksV8Project", () => {
  test("only the server's marker 8 counts", () => {
    expect(isBlocksV8Project({ blocksMajor: 8 })).toBe(true);
    expect(isBlocksV8Project({ blocksMajor: "8" })).toBe(false);
    expect(isBlocksV8Project({ blocksMajor: 7 })).toBe(false);
    expect(isBlocksV8Project({})).toBe(false);
    expect(isBlocksV8Project(null)).toBe(false);
  });
});

describe("Blocks v8 is always Fast Preview; v7 keeps main's rule", () => {
  const URL = "https://acme.com";
  // [marker, fastPreview, preview URL] -> default runtime
  const rows: Array<
    [8 | undefined, boolean | undefined, string | undefined, "cms" | "sandbox"]
  > = [
    // v7 (no marker): exactly main's rule — the switch AND a URL.
    [undefined, true, URL, "cms"],
    [undefined, false, URL, "sandbox"],
    [undefined, undefined, URL, "sandbox"],
    [undefined, true, undefined, "sandbox"],
    [undefined, false, undefined, "sandbox"],
    // v8: always cms with a URL, whatever a stale switch says.
    [8, true, URL, "cms"],
    [8, false, URL, "cms"],
    [8, undefined, URL, "cms"],
    // v8 with no URL still has nothing to render against.
    [8, true, undefined, "sandbox"],
    [8, undefined, undefined, "sandbox"],
  ];
  for (const [blocksMajor, fastPreview, previewServerUrl, expected] of rows) {
    test(`marker=${blocksMajor} fastPreview=${fastPreview} url=${!!previewServerUrl} -> ${expected}`, () => {
      const meta = { blocksMajor, fastPreview, previewServerUrl };
      expect(defaultThreadRuntime(meta)).toBe(expected);
      expect(fastPreviewCapability(meta)).toBe(expected === "cms");
    });
  }

  test("a stamp still wins on a v8 project", () => {
    expect(
      readThreadRuntime(
        { runtime: "sandbox" },
        { blocksMajor: 8, previewServerUrl: URL },
      ),
    ).toBe("sandbox");
  });
});

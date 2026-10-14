import { describe, expect, it } from "bun:test";

type Node = {
  label: string;
  tappable: boolean;
  box: { x: number; y: number; width: number; height: number };
};
type Hit = { node?: Node; ambiguous?: Node[] };
type Engine = "chromium" | "webkit";
type Parsed = {
  error?: string;
  url?: string;
  outfile?: string;
  engine?: Engine;
  mobile?: boolean;
  fullPage?: boolean;
  selector?: string | null;
  wantsConsole?: boolean;
  label?: string | null;
  flutter?: boolean;
  type?: "png" | "jpeg";
};
type Context = {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  userAgent?: string;
};

/** The bin is extensionless CJS, so `require` reaches its pure helpers without
 *  loading playwright — which only exists inside the sandbox image. */
const { contextOptions, findSemanticsByLabel, launchOptions, parseArgs } =
  require("./image/bin/qa-screenshot") as {
    contextOptions: (
      opts: { engine: Engine; mobile: boolean },
      devices: Record<string, Context>,
    ) => Context;
    findSemanticsByLabel: (nodes: Node[], label: string) => Hit;
    launchOptions: (opts: { engine: Engine; flutter: boolean }) => {
      executablePath?: string;
      args?: string[];
    };
    parseArgs: (argv: string[]) => Parsed;
  };

const node = (label: string, x = 0) => ({
  label,
  tappable: true,
  box: { x, y: 0, width: 10, height: 10 },
});

describe("findSemanticsByLabel", () => {
  it("returns the single exact match", () => {
    const wanted = node("Increment");
    expect(
      findSemanticsByLabel([node("Decrement"), wanted], "Increment"),
    ).toEqual({
      node: wanted,
    });
  });

  it("reports duplicate EXACT labels as ambiguous instead of picking one", () => {
    const hit = findSemanticsByLabel(
      [node("Delete", 0), node("Delete", 99)],
      "Delete",
    );
    expect(hit.node).toBeUndefined();
    expect(hit.ambiguous).toHaveLength(2);
  });

  it("falls back to a unique case-insensitive substring", () => {
    const wanted = node("Sign in with Google");
    expect(findSemanticsByLabel([node("Cancel"), wanted], "google")).toEqual({
      node: wanted,
    });
  });

  it("reports an ambiguous substring", () => {
    const hit = findSemanticsByLabel(
      [node("Save draft"), node("Save and close")],
      "Save",
    );
    expect(hit.node).toBeUndefined();
    expect(hit.ambiguous?.map((n) => n.label)).toEqual([
      "Save draft",
      "Save and close",
    ]);
  });

  it("prefers the exact match over substrings that contain it", () => {
    const wanted = node("Save");
    expect(
      findSemanticsByLabel(
        [node("Save draft"), wanted, node("Save and close")],
        "Save",
      ),
    ).toEqual({ node: wanted });
  });

  it("returns nothing when no widget matches", () => {
    expect(findSemanticsByLabel([node("Cancel")], "Increment")).toEqual({});
  });
});

describe("parseArgs", () => {
  it("defaults to chromium", () => {
    expect(parseArgs(["http://localhost:3000", "a.png"])).toMatchObject({
      url: "http://localhost:3000",
      outfile: "a.png",
      engine: "chromium",
      mobile: false,
      type: "png",
    });
  });

  it("accepts --engine=webkit alongside the other flags", () => {
    expect(
      parseArgs([
        "--engine=webkit",
        "http://localhost:3000",
        "a.jpg",
        "--mobile",
        "--console",
        "--selector=[data-x=a=b]",
      ]),
    ).toMatchObject({
      engine: "webkit",
      mobile: true,
      wantsConsole: true,
      selector: "[data-x=a=b]",
      type: "jpeg",
    });
  });

  it("rejects an engine it cannot launch", () => {
    expect(parseArgs(["u", "a.png", "--engine=firefox"]).error).toContain(
      '--engine must be one of chromium, webkit, got "firefox"',
    );
  });

  it("rejects a bare or empty --engine instead of falling back", () => {
    expect(parseArgs(["u", "a.png", "--engine"]).error).toContain("got true");
    expect(parseArgs(["u", "a.png", "--engine="]).error).toContain('got ""');
  });

  it("reports usage without both positionals", () => {
    expect(parseArgs(["u", "--engine=webkit"]).error).toStartWith("usage:");
  });

  it("implies --flutter from --label", () => {
    expect(parseArgs(["u", "a.png", "--label=Increment"])).toMatchObject({
      label: "Increment",
      flutter: true,
    });
  });
});

describe("contextOptions", () => {
  const iphone = {
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 3,
    userAgent: "iPhone descriptor",
  };
  const devices = { "iPhone 13": iphone };

  it("emulates Playwright's iPhone for a WebKit phone", () => {
    expect(contextOptions({ engine: "webkit", mobile: true }, devices)).toBe(
      iphone,
    );
  });

  it("keeps the shared phone framing in Chromium", () => {
    const phone = contextOptions({ engine: "chromium", mobile: true }, devices);
    expect(phone.viewport).toEqual({ width: 390, height: 844 });
    expect(phone.userAgent).toContain("iPhone");
  });

  it("frames desktop the same in both engines", () => {
    expect(contextOptions({ engine: "webkit", mobile: false }, devices)).toBe(
      contextOptions({ engine: "chromium", mobile: false }, devices),
    );
  });
});

describe("launchOptions", () => {
  it("passes Chromium-only flags to Chromium alone", () => {
    expect(launchOptions({ engine: "chromium", flutter: true }).args).toEqual([
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
    ]);
    expect(launchOptions({ engine: "webkit", flutter: true })).toEqual({});
  });
});

import { describe, expect, it } from "bun:test";
import {
  APPS_SCHEDULING_VERSION,
  APPS_STATUS_VERSION,
  appsVersionFromDenoJson,
  appsVersionFromMeta,
  blogSupport,
  compareSemver,
  parseSemver,
  postStatusUnsupported,
  supportsPublishToggle,
  supportsScheduling,
} from "./blog-capabilities";

/**
 * A `deno.json` pinning apps to `version`. Shape taken verbatim from
 * `deco-sites/content-hub`, which pins `"apps/"` alongside unrelated imports.
 */
function denoJson(version: string): unknown {
  return {
    imports: {
      "@deco/deco": "jsr:@deco/deco@1.208.0",
      "apps/": `https://cdn.jsdelivr.net/gh/deco-cx/apps@${version}/`,
      "deco/": "https://cdn.jsdelivr.net/gh/deco-cx/deco@1.208.0/",
    },
  };
}

/**
 * A `/live/_meta` payload whose schema refs pin apps to `version`, shaped like
 * the real one: most definitions are site-local and carry no apps ref at all.
 */
function meta(version: string): unknown {
  return {
    schema: {
      definitions: {
        local: { title: "MyOwnSection" },
        blank: {},
        apps: {
          title: `https://cdn.jsdelivr.net/gh/deco-cx/apps@${version}/blog/loaders/BlogPostPage.ts@Props`,
        },
      },
    },
  };
}

describe("parseSemver", () => {
  it("parses a plain and a v-prefixed version", () => {
    expect(parseSemver("0.161.0")).toEqual([0, 161, 0]);
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("rejects anything that isn't three numeric parts", () => {
    expect(parseSemver("0.161")).toBeNull();
    expect(parseSemver("0.161.0-beta.1")).toBeNull();
    expect(parseSemver("main")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("compares numerically, not lexically", () => {
    expect(compareSemver("0.161.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.162.0", "0.161.9")).toBeGreaterThan(0);
    expect(compareSemver("0.161.0", "0.162.0")).toBeLessThan(0);
    expect(compareSemver("0.161.0", "0.161.0")).toBe(0);
  });
});

describe("appsVersionFromDenoJson", () => {
  /** Shape taken verbatim from deco-sites/content-hub's deno.json. */
  it("reads the pin a real site commits", () => {
    expect(appsVersionFromDenoJson(denoJson("0.162.0"))).toBe("0.162.0");
  });

  it("reads the pin regardless of the import's name", () => {
    expect(
      appsVersionFromDenoJson({
        imports: {
          "deco/apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@0.155.2/",
        },
      }),
    ).toBe("0.155.2");
  });

  it("does not mistake the deco runtime pin for the apps pin", () => {
    expect(
      appsVersionFromDenoJson({
        imports: {
          "deco/": "https://cdn.jsdelivr.net/gh/deco-cx/deco@1.208.0/",
        },
      }),
    ).toBeNull();
  });

  it("returns null for a branch or commit pin", () => {
    expect(
      appsVersionFromDenoJson({
        imports: { "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@main/" },
      }),
    ).toBeNull();
  });

  it("survives a missing, malformed or non-object deno.json", () => {
    expect(appsVersionFromDenoJson(null)).toBeNull();
    expect(appsVersionFromDenoJson(undefined)).toBeNull();
    expect(appsVersionFromDenoJson({})).toBeNull();
    expect(appsVersionFromDenoJson({ imports: "nope" })).toBeNull();
    expect(appsVersionFromDenoJson({ imports: { "apps/": 42 } })).toBeNull();
  });
});

describe("appsVersionFromMeta", () => {
  it("finds the pin past definitions that don't carry one", () => {
    expect(appsVersionFromMeta(meta("0.161.0"))).toBe("0.161.0");
  });

  /** Shape taken verbatim from content-hub.deco.site's /live/_meta. */
  it("reads the ref shape a real site emits", () => {
    expect(
      appsVersionFromMeta({
        schema: {
          definitions: {
            a: {
              title:
                "https://cdn.jsdelivr.net/gh/deco-cx/apps@0.162.0/website/functions/requestToParam.ts@Props",
            },
          },
        },
      }),
    ).toBe("0.162.0");
  });

  it("reads a raw.githubusercontent ref", () => {
    expect(
      appsVersionFromMeta({
        schema: {
          definitions: {
            a: {
              title:
                "https://raw.githubusercontent.com/deco-cx/apps@0.160.1/mod.ts",
            },
          },
        },
      }),
    ).toBe("0.160.1");
  });

  it("returns null for a branch or commit ref", () => {
    expect(
      appsVersionFromMeta({
        schema: {
          definitions: {
            a: {
              title: "https://cdn.jsdelivr.net/gh/deco-cx/apps@main/mod.ts",
            },
          },
        },
      }),
    ).toBeNull();
  });

  it("returns null when no definition references apps", () => {
    expect(
      appsVersionFromMeta({
        schema: { definitions: { a: { title: "MyOwnSection" } } },
      }),
    ).toBeNull();
  });

  it("survives a missing, malformed or non-object meta", () => {
    expect(appsVersionFromMeta(null)).toBeNull();
    expect(appsVersionFromMeta(undefined)).toBeNull();
    expect(appsVersionFromMeta({})).toBeNull();
    expect(appsVersionFromMeta({ schema: {} })).toBeNull();
    expect(appsVersionFromMeta({ schema: { definitions: "nope" } })).toBeNull();
    expect(
      appsVersionFromMeta({ schema: { definitions: { a: 42, b: null } } }),
    ).toBeNull();
  });
});

describe("blogSupport", () => {
  /** Deno with both sources agreeing — the ordinary case. */
  const deno = (version: string) => ({
    packageManager: "deno",
    denoJson: denoJson(version),
    meta: meta(version),
  });

  it("reports a non-Deno runtime as unsupported", () => {
    expect(
      blogSupport({ ...deno(APPS_SCHEDULING_VERSION), packageManager: "bun" }),
    ).toEqual({ kind: "unsupported-runtime" });
  });

  it("reports an undetected runtime as unsupported, not as Deno", () => {
    expect(
      blogSupport({ packageManager: null, denoJson: null, meta: null }),
    ).toEqual({ kind: "unsupported-runtime" });
  });

  it("reports a pin below the status version as outdated", () => {
    expect(blogSupport(deno("0.160.9"))).toEqual({
      kind: "outdated",
      version: "0.160.9",
    });
  });

  it("reports the status version as publish-only", () => {
    expect(blogSupport(deno(APPS_STATUS_VERSION))).toEqual({
      kind: "publish-only",
      version: APPS_STATUS_VERSION,
    });
  });

  it("keeps a patch above the status version publish-only", () => {
    expect(blogSupport(deno("0.161.7"))).toEqual({
      kind: "publish-only",
      version: "0.161.7",
    });
  });

  it("reports the scheduling version and above as full", () => {
    expect(blogSupport(deno(APPS_SCHEDULING_VERSION))).toEqual({
      kind: "full",
      version: APPS_SCHEDULING_VERSION,
    });
    expect(blogSupport(deno("1.0.0"))).toEqual({
      kind: "full",
      version: "1.0.0",
    });
  });

  it("prefers this branch's deno.json over a meta served by production", () => {
    expect(
      blogSupport({
        packageManager: "deno",
        denoJson: denoJson(APPS_SCHEDULING_VERSION),
        meta: meta(APPS_STATUS_VERSION),
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("falls back to meta when the daemon couldn't read deno.json", () => {
    expect(
      blogSupport({
        packageManager: "deno",
        denoJson: null,
        meta: meta(APPS_SCHEDULING_VERSION),
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("falls back to meta when deno.json carries a branch pin", () => {
    expect(
      blogSupport({
        packageManager: "deno",
        denoJson: {
          imports: {
            "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@main/",
          },
        },
        meta: meta(APPS_SCHEDULING_VERSION),
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("fails closed when neither source answers", () => {
    expect(
      blogSupport({ packageManager: "deno", denoJson: null, meta: null }),
    ).toEqual({ kind: "outdated", version: null });
    expect(
      blogSupport({
        packageManager: "deno",
        denoJson: {
          imports: {
            "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@main/",
          },
        },
        meta: { schema: { definitions: { a: { title: "MyOwnSection" } } } },
      }),
    ).toEqual({ kind: "outdated", version: null });
  });
});

describe("supportsPublishToggle / supportsScheduling", () => {
  it("gates publish on status support and scheduling on full support", () => {
    const cases = [
      {
        support: { kind: "unsupported-runtime" } as const,
        pub: false,
        sched: false,
      },
      {
        support: { kind: "outdated", version: null } as const,
        pub: false,
        sched: false,
      },
      {
        support: { kind: "publish-only", version: "0.161.0" } as const,
        pub: true,
        sched: false,
      },
      {
        support: { kind: "full", version: "0.162.0" } as const,
        pub: true,
        sched: true,
      },
    ];
    for (const { support, pub, sched } of cases) {
      expect(supportsPublishToggle(support)).toBe(pub);
      expect(supportsScheduling(support)).toBe(sched);
    }
  });
});

describe("postStatusUnsupported", () => {
  const outdated = { kind: "outdated", version: "0.160.0" } as const;
  const publishOnly = { kind: "publish-only", version: "0.161.0" } as const;
  const full = { kind: "full", version: "0.162.0" } as const;
  const noRuntime = { kind: "unsupported-runtime" } as const;

  it("never gates a non-live state — those blocks the site does not resolve", () => {
    for (const support of [noRuntime, outdated, publishOnly, full]) {
      for (const status of [
        "draft",
        "generating",
        "awaiting_review",
        "archived",
      ] as const) {
        expect(postStatusUnsupported(support, status)).toBeNull();
      }
    }
  });

  it("gates scheduled until the app can hold a go-live instant", () => {
    expect(postStatusUnsupported(publishOnly, "scheduled")).toEqual({
      required: APPS_SCHEDULING_VERSION,
      version: "0.161.0",
    });
    expect(postStatusUnsupported(full, "scheduled")).toBeNull();
  });

  it("gates published until the app can read status at all", () => {
    expect(postStatusUnsupported(outdated, "published")).toEqual({
      required: APPS_STATUS_VERSION,
      version: "0.160.0",
    });
    expect(postStatusUnsupported(publishOnly, "published")).toBeNull();
  });

  it("reports a null version on a site that is not Deno at all", () => {
    expect(postStatusUnsupported(noRuntime, "published")?.version).toBeNull();
  });
});

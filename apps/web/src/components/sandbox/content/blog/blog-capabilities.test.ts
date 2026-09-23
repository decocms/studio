import { describe, expect, it } from "bun:test";
import {
  APPS_SCHEDULING_VERSION,
  APPS_STATUS_VERSION,
  BLOG_PACKAGE_VERSION,
  appsVersionFromDenoJson,
  appsVersionFromMeta,
  blogPackageRange,
  blogSupport,
  blogUpdateCommand,
  compareSemver,
  metaDescribesScheduling,
  parseSemver,
  postStatusUnsupported,
  supportsPublishToggle,
  supportsScheduling,
  versionFromRange,
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

/**
 * A `/live/_meta` whose section props inline `BlogPost`, which is how both
 * runtimes serve it — shape trimmed from zeenow-tanstack.deco.site and
 * content-hub.deco.site, where `scheduledDatetime` sits four levels deep.
 */
function metaWithBlogSchema(scheduling: boolean): unknown {
  const post: Record<string, unknown> = {
    slug: { type: "string" },
    status: { type: "string", enum: ["draft", "published"] },
  };
  if (scheduling) post.scheduledDatetime = { type: "string" };
  return {
    schema: {
      definitions: {
        "site/sections/Blog/BlogPostBlocks.tsx@Props": {
          type: "object",
          properties: {
            post: { type: "object", properties: post },
          },
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

describe("blogPackageRange", () => {
  it("reads the pin a real TanStack site commits", () => {
    expect(
      blogPackageRange({
        dependencies: {
          "@decocms/apps-blog": "7.64.3",
          "@decocms/blocks": "7.64.3",
        },
      }),
    ).toBe("7.64.3");
  });

  it("reads a dev dependency too", () => {
    expect(
      blogPackageRange({
        devDependencies: { "@decocms/apps-blog": "^7.53.0" },
      }),
    ).toBe("^7.53.0");
  });

  it("returns null when the site installs no blog app", () => {
    expect(blogPackageRange({ dependencies: { react: "19.0.0" } })).toBeNull();
    expect(blogPackageRange(null)).toBeNull();
    expect(blogPackageRange({})).toBeNull();
    expect(blogPackageRange({ dependencies: "nope" })).toBeNull();
    expect(
      blogPackageRange({ dependencies: { "@decocms/apps-blog": 42 } }),
    ).toBeNull();
  });
});

describe("versionFromRange", () => {
  it("reads an exact pin and the caret/tilde ranges", () => {
    expect(versionFromRange("7.64.3")).toBe("7.64.3");
    expect(versionFromRange("^7.53.0")).toBe("7.53.0");
    expect(versionFromRange("~7.53.1")).toBe("7.53.1");
    expect(versionFromRange(" v7.53.0 ")).toBe("7.53.0");
  });

  it("returns null for a range that names no floor", () => {
    expect(versionFromRange("latest")).toBeNull();
    expect(versionFromRange("*")).toBeNull();
    expect(versionFromRange("workspace:*")).toBeNull();
    expect(versionFromRange(">=7.53.0")).toBeNull();
    expect(versionFromRange("github:decocms/blocks")).toBeNull();
  });
});

describe("blogUpdateCommand", () => {
  it("uses the repo's own task on Deno", () => {
    expect(blogUpdateCommand("deno")).toBe("deno task update");
  });

  it("moves the whole @decocms scope with the site's package manager", () => {
    expect(blogUpdateCommand("bun")).toContain("bun install");
    expect(blogUpdateCommand("bun")).toContain("@decocms/*");
    expect(blogUpdateCommand("pnpm")).toContain("pnpm install");
  });
});

describe("metaDescribesScheduling", () => {
  it("finds the inlined BlogPost a real site serves", () => {
    expect(metaDescribesScheduling(metaWithBlogSchema(true))).toBe(true);
  });

  it("is false for an app whose BlogPost has no go-live instant", () => {
    expect(metaDescribesScheduling(metaWithBlogSchema(false))).toBe(false);
  });

  it("walks past arrays and unrelated nodes", () => {
    expect(
      metaDescribesScheduling({
        schema: {
          definitions: {
            a: { anyOf: [{ properties: { scheduledDatetime: {} } }] },
          },
        },
      }),
    ).toBe(true);
  });

  it("ignores a `scheduledDatetime` that isn't a schema property", () => {
    expect(
      metaDescribesScheduling({
        schema: { definitions: { a: { title: "scheduledDatetime" } } },
      }),
    ).toBe(false);
  });

  it("survives a missing or malformed meta", () => {
    expect(metaDescribesScheduling(null)).toBe(false);
    expect(metaDescribesScheduling(undefined)).toBe(false);
    expect(metaDescribesScheduling({})).toBe(false);
    expect(metaDescribesScheduling({ schema: { definitions: "nope" } })).toBe(
      false,
    );
  });
});

describe("blogSupport", () => {
  const data = (value: unknown) => ({ kind: "data", data: value }) as const;
  const absent = { kind: "absent" } as const;
  const unavailable = { kind: "unavailable" } as const;

  /** Deno with both sources agreeing — the ordinary case. */
  const deno = (version: string) => ({
    denoJson: data(denoJson(version)),
    packageJson: absent,
    meta: meta(version),
  });

  /** A TanStack site pinning the blog app, as `deco-sites/*-tanstack` do. */
  const node = (version: string | null) => ({
    denoJson: absent,
    packageJson: data({
      packageManager: "bun@1.3.5",
      dependencies: version ? { "@decocms/apps-blog": version } : {},
    }),
    meta: null,
  });

  it("reads the repo, not the runtime picker — a fresh import has none", () => {
    expect(blogSupport(node("7.64.3"))).toEqual({
      kind: "full",
      version: "7.64.3",
    });
  });

  it("reports a site that installs no blog app as unsupported", () => {
    expect(blogSupport(node(null))).toEqual({ kind: "unsupported-runtime" });
  });

  it("takes the served schema as proof when no manifest is readable", () => {
    expect(
      blogSupport({
        denoJson: unavailable,
        packageJson: unavailable,
        meta: metaWithBlogSchema(true),
      }),
    ).toEqual({ kind: "full", version: null });
  });

  it("keeps the branch's own pin above the schema production serves", () => {
    expect(
      blogSupport({
        denoJson: absent,
        packageJson: data({
          dependencies: { "@decocms/apps-blog": "7.52.1" },
        }),
        meta: metaWithBlogSchema(true),
      }),
    ).toEqual({ kind: "outdated", packageManager: "npm", version: "7.52.1" });
  });

  it("says unknown, not unsupported, while a manifest is unread", () => {
    expect(
      blogSupport({
        denoJson: unavailable,
        packageJson: unavailable,
        meta: null,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      blogSupport({ denoJson: absent, packageJson: unavailable, meta: null }),
    ).toEqual({ kind: "unknown" });
  });

  it("reports a repo committing neither manifest as unsupported", () => {
    expect(
      blogSupport({ denoJson: absent, packageJson: absent, meta: null }),
    ).toEqual({ kind: "unsupported-runtime" });
  });

  it("reports a pin below the status version as outdated", () => {
    expect(blogSupport(deno("0.160.9"))).toEqual({
      kind: "outdated",
      packageManager: "deno",
      version: "0.160.9",
    });
  });

  it("reports the status version as publish-only", () => {
    expect(blogSupport(deno(APPS_STATUS_VERSION))).toEqual({
      kind: "publish-only",
      packageManager: "deno",
      version: APPS_STATUS_VERSION,
    });
  });

  it("keeps a patch above the status version publish-only", () => {
    expect(blogSupport(deno("0.161.7"))).toEqual({
      kind: "publish-only",
      packageManager: "deno",
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

  it("reports the blog package version and above as full on a TanStack site", () => {
    expect(blogSupport(node(BLOG_PACKAGE_VERSION))).toEqual({
      kind: "full",
      version: BLOG_PACKAGE_VERSION,
    });
    expect(blogSupport(node("8.0.0"))).toEqual({
      kind: "full",
      version: "8.0.0",
    });
  });

  it("never lands a TanStack site on publish-only — one release brought both", () => {
    expect(blogSupport(node("7.52.1"))).toEqual({
      kind: "outdated",
      packageManager: "bun",
      version: "7.52.1",
    });
  });

  it("takes the update command's package manager from package.json", () => {
    expect(
      blogSupport({
        denoJson: absent,
        packageJson: data({ dependencies: { "@decocms/apps-blog": "7.0.0" } }),
        meta: null,
      }),
    ).toEqual({ kind: "outdated", packageManager: "npm", version: "7.0.0" });
  });

  it("fails closed on a blog pin it cannot read", () => {
    expect(blogSupport(node("workspace:*"))).toEqual({
      kind: "outdated",
      packageManager: "bun",
      version: null,
    });
  });

  it("lets a committed deno.json win over a package.json beside it", () => {
    expect(
      blogSupport({
        denoJson: data(denoJson(APPS_SCHEDULING_VERSION)),
        packageJson: data({ dependencies: { "@decocms/apps-blog": "7.0.0" } }),
        meta: null,
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("prefers this branch's deno.json over a meta served by production", () => {
    expect(
      blogSupport({
        denoJson: data(denoJson(APPS_SCHEDULING_VERSION)),
        packageJson: absent,
        meta: meta(APPS_STATUS_VERSION),
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("falls back to meta when the daemon couldn't read deno.json", () => {
    expect(
      blogSupport({
        denoJson: unavailable,
        packageJson: unavailable,
        meta: meta(APPS_SCHEDULING_VERSION),
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("falls back to meta when deno.json carries a branch pin", () => {
    expect(
      blogSupport({
        denoJson: data({
          imports: {
            "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@main/",
          },
        }),
        packageJson: absent,
        meta: meta(APPS_SCHEDULING_VERSION),
      }),
    ).toEqual({ kind: "full", version: APPS_SCHEDULING_VERSION });
  });

  it("fails closed when neither source answers for a Deno repo", () => {
    expect(
      blogSupport({
        denoJson: data({ imports: {} }),
        packageJson: absent,
        meta: null,
      }),
    ).toEqual({ kind: "outdated", packageManager: "deno", version: null });
    expect(
      blogSupport({
        denoJson: data({
          imports: {
            "apps/": "https://cdn.jsdelivr.net/gh/deco-cx/apps@main/",
          },
        }),
        packageJson: absent,
        meta: { schema: { definitions: { a: { title: "MyOwnSection" } } } },
      }),
    ).toEqual({ kind: "outdated", packageManager: "deno", version: null });
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
        support: {
          kind: "outdated",
          packageManager: "deno",
          version: null,
        } as const,
        pub: false,
        sched: false,
      },
      {
        support: {
          kind: "publish-only",
          packageManager: "deno",
          version: "0.161.0",
        } as const,
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
  const outdated = {
    kind: "outdated",
    packageManager: "deno",
    version: "0.160.0",
  } as const;
  const publishOnly = {
    kind: "publish-only",
    packageManager: "deno",
    version: "0.161.0",
  } as const;
  const full = { kind: "full", version: "0.162.0" } as const;
  const noApp = { kind: "unsupported-runtime" } as const;
  const unknown = { kind: "unknown" } as const;
  const nodeOutdated = {
    kind: "outdated",
    packageManager: "bun",
    version: "7.52.1",
  } as const;

  it("never gates a non-live state — those blocks the site does not resolve", () => {
    for (const support of [unknown, noApp, outdated, publishOnly, full]) {
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
      reason: "outdated",
      required: APPS_SCHEDULING_VERSION,
      version: "0.161.0",
      command: blogUpdateCommand("deno"),
    });
    expect(postStatusUnsupported(full, "scheduled")).toBeNull();
  });

  it("gates published until the app can read status at all", () => {
    expect(postStatusUnsupported(outdated, "published")).toEqual({
      reason: "outdated",
      required: APPS_STATUS_VERSION,
      version: "0.160.0",
      command: blogUpdateCommand("deno"),
    });
    expect(postStatusUnsupported(publishOnly, "published")).toBeNull();
  });

  it("asks a TanStack site for the blog package version, with its own command", () => {
    for (const status of ["scheduled", "published"] as const) {
      expect(postStatusUnsupported(nodeOutdated, status)).toEqual({
        reason: "outdated",
        required: BLOG_PACKAGE_VERSION,
        version: "7.52.1",
        command: blogUpdateCommand("bun"),
      });
    }
  });

  it("separates a site with no blog app from one not read yet", () => {
    expect(postStatusUnsupported(noApp, "published")).toEqual({
      reason: "no-app",
    });
    expect(postStatusUnsupported(unknown, "published")).toEqual({
      reason: "unknown",
    });
  });
});

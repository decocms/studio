import { describe, expect, test } from "bun:test";
import {
  findAnalyticsSite,
  pickStudioProject,
  projectConfirmsStore,
  toStudioProject,
} from "./studio-project.ts";

// A cut of COLLECTION_VIRTUAL_MCP_LIST.
const loja = {
  id: "vir_loja",
  title: "loja",
  metadata: {
    siteSlug: "loja",
    productionUrl: "https://www.loja.example/",
    repository: {
      owner: "acme",
      name: "loja",
      connectionId: "conn_github",
    },
    runtime: { selected: "deno" },
  },
};
const storefront = {
  id: "vir_storefront",
  title: "loja storefront",
  metadata: {
    siteSlug: "loja-storefront",
    repository: { owner: "acme", name: "loja-storefront" },
    runtime: { selected: "bun" },
  },
};
const agent = {
  id: "vir_agente",
  title: "Agente",
  metadata: {},
};

describe("toStudioProject", () => {
  test("reads domain, slug, repo and runtime from the project", () => {
    expect(toStudioProject(loja)).toEqual({
      id: "vir_loja",
      title: "loja",
      site_slug: "loja",
      domain: "www.loja.example",
      repository: {
        owner: "acme",
        name: "loja",
        connection_id: "conn_github",
      },
      runtime: "deno",
    });
  });

  test("reads the host and repository id in Studio, when the project has them", () => {
    const item = {
      metadata: {
        siteSlug: "loja",
        repository: {
          owner: "grupo",
          name: "loja",
          url: "https://gitlab.com/grupo/loja.git",
          repositoryId: "repo_1",
        },
      },
    };
    expect(toStudioProject(item)?.repository).toEqual({
      owner: "grupo",
      name: "loja",
      connection_id: null,
      provider: "gitlab",
      host: "gitlab.com",
      repository_id: "repo_1",
    });
  });

  test("reads the domain from previewServerUrl", () => {
    const item = {
      metadata: {
        siteSlug: "loja",
        previewServerUrl: "https://www.loja.example/",
      },
    };
    expect(toStudioProject(item)?.domain).toBe("www.loja.example");
  });

  test("previewServerUrl beats productionUrl", () => {
    const item = {
      metadata: {
        siteSlug: "loja",
        previewServerUrl: "https://www.loja.example/",
        productionUrl: "https://www.antiga.example/",
      },
    };
    expect(toStudioProject(item)?.domain).toBe("www.loja.example");
  });

  test("ignores deco.site", () => {
    const previewServerUrl = "https://loja.deco.site/";
    expect(
      toStudioProject({ metadata: { siteSlug: "loja", previewServerUrl } })
        ?.domain,
    ).toBeNull();
    expect(
      toStudioProject({
        metadata: {
          siteSlug: "loja",
          previewServerUrl,
          productionUrl: "https://www.loja.example/",
        },
      })?.domain,
    ).toBe("www.loja.example");
  });

  test("an agent (no siteSlug) is not a site project", () => {
    expect(toStudioProject(agent)).toBeNull();
  });
});

describe("pickStudioProject", () => {
  test("with two sites, the one in production wins", () => {
    const p = pickStudioProject([agent, storefront, loja], {
      orgSlug: "loja",
    });
    expect(p?.site_slug).toBe("loja");
  });

  test("the already known domain decides, with or without www", () => {
    const other = {
      ...storefront,
      metadata: {
        ...storefront.metadata,
        productionUrl: "https://novo.loja.com.br",
      },
    };
    expect(
      pickStudioProject([loja, other], {
        orgSlug: "loja",
        domain: "novo.loja.com.br",
      })?.site_slug,
    ).toBe("loja-storefront");
    expect(
      pickStudioProject([other, loja], {
        orgSlug: "x",
        domain: "loja.example",
      })?.site_slug,
    ).toBe("loja");
  });

  test("an org without a site returns null", () => {
    expect(pickStudioProject([agent], { orgSlug: "loja" })).toBeNull();
  });
});

describe("projectConfirmsStore", () => {
  const project = (domain: string | null) => ({ domain });

  test("the project domain is the store's (with or without www.)", () => {
    expect(
      projectConfirmsStore(project("www.loja.example"), "loja.example"),
    ).toBe(true);
  });

  // A project with siteSlug and no productionUrl can be any Virtual MCP.
  test("a project without a domain confirms nothing", () => {
    expect(projectConfirmsStore(project(null), "www.outra.example")).toBe(
      false,
    );
  });

  test("a project from another store does not confirm", () => {
    expect(
      projectConfirmsStore(project("www.loja.example"), "www.outra.example"),
    ).toBe(false);
  });
});

describe("findAnalyticsSite", () => {
  const project = (site_slug: string, domain: string | null = null) => ({
    id: site_slug,
    title: site_slug,
    site_slug,
    domain,
    repository: null,
    runtime: null,
  });
  const opts = { orgSlug: "org", domain: null };

  test("finds the registered site even without a domain on the project", async () => {
    const found = await findAnalyticsSite(
      [project("a"), project("b")],
      async (slug) => slug === "b",
      opts,
    );
    expect(found).toBe("b");
  });

  test("the domain's project is tried first", async () => {
    const probed: string[] = [];
    const found = await findAnalyticsSite(
      [project("a"), project("b", "www.loja.example")],
      async (slug) => {
        probed.push(slug);
        return true;
      },
      { orgSlug: "org", domain: "loja.example" },
    );
    expect(found).toBe("b");
    expect(probed).toEqual(["b"]);
  });

  test("the org slug comes before the others", async () => {
    const probed: string[] = [];
    await findAnalyticsSite(
      [project("a"), project("org")],
      async (slug) => {
        probed.push(slug);
        return false;
      },
      opts,
    );
    expect(probed).toEqual(["org", "a"]);
  });

  test("none registered", async () => {
    const found = await findAnalyticsSite(
      [project("a"), project("b")],
      async () => false,
      opts,
    );
    expect(found).toBeNull();
  });

  test("a failing probe counts as not registered", async () => {
    const found = await findAnalyticsSite(
      [project("a"), project("b")],
      async (slug) => {
        if (slug === "a") throw new Error("boom");
        return true;
      },
      opts,
    );
    expect(found).toBe("b");
  });
});

import { describe, expect, test } from "bun:test";
import {
  findAnalyticsSite,
  pickStudioProject,
  projectConfirmsStore,
  toStudioProject,
} from "./studio-project.ts";

// Um recorte de COLLECTION_VIRTUAL_MCP_LIST.
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
  test("lê domínio, slug, repo e runtime do projeto", () => {
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

  test("lê o host e o id do repositório no Studio, quando o projeto tem", () => {
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

  test("lê o domínio de previewServerUrl", () => {
    const item = {
      metadata: {
        siteSlug: "loja",
        previewServerUrl: "https://www.loja.example/",
      },
    };
    expect(toStudioProject(item)?.domain).toBe("www.loja.example");
  });

  test("previewServerUrl vence productionUrl", () => {
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

  test("agente (sem siteSlug) não é projeto de site", () => {
    expect(toStudioProject(agent)).toBeNull();
  });
});

describe("pickStudioProject", () => {
  test("com dois sites, vence o que está em produção", () => {
    const p = pickStudioProject([agent, storefront, loja], {
      orgSlug: "loja",
    });
    expect(p?.site_slug).toBe("loja");
  });

  test("o domínio já conhecido decide, com ou sem www", () => {
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

  test("org sem site devolve null", () => {
    expect(pickStudioProject([agent], { orgSlug: "loja" })).toBeNull();
  });
});

describe("projectConfirmsStore", () => {
  const project = (domain: string | null) => ({ domain });

  test("o domínio do projeto é o da loja (com ou sem www.)", () => {
    expect(
      projectConfirmsStore(project("www.loja.example"), "loja.example"),
    ).toBe(true);
  });

  // Um projeto com siteSlug e sem productionUrl pode ser qualquer Virtual MCP.
  test("projeto sem domínio não confirma nada", () => {
    expect(projectConfirmsStore(project(null), "www.outra.example")).toBe(
      false,
    );
  });

  test("projeto de outra loja não confirma", () => {
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

  test("acha o site registrado mesmo sem domínio no projeto", async () => {
    const found = await findAnalyticsSite(
      [project("a"), project("b")],
      async (slug) => slug === "b",
      opts,
    );
    expect(found).toBe("b");
  });

  test("o projeto do domínio é tentado primeiro", async () => {
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

  test("o slug da org vem antes dos demais", async () => {
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

  test("nenhum registrado", async () => {
    const found = await findAnalyticsSite(
      [project("a"), project("b")],
      async () => false,
      opts,
    );
    expect(found).toBeNull();
  });

  test("probe que falha conta como não registrado", async () => {
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

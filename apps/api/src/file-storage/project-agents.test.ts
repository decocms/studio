import { describe, expect, it } from "bun:test";
import { parseAgentMd, renderAgentMd } from "@decocms/shared/harness/agent-md";
import type { OrgFsEntry } from "../storage/org-fs";
import type { OrgFs } from "./org-fs";
import {
  listProjectAgents,
  type ProjectRef,
  readProjectAgent,
  seedProjectAgents,
} from "./project-agents";

const PROJECT: ProjectRef = {
  id: "vmcp_1",
  title: "Acme",
  metadata: { projectFolderName: "acme" },
};
const BASE = "projects/acme/agents";

function dirEntry(path: string, kind: "file" | "dir"): OrgFsEntry {
  return {
    organizationId: "org_1",
    volume: "home",
    path,
    parent: path.slice(0, path.lastIndexOf("/")),
    kind,
    contentHash: null,
    size: 0,
    seq: "1",
    deletedAt: null,
    createdBy: "u",
    createdAt: "",
    updatedBy: "u",
    updatedAt: "",
    threadId: null,
    readPublic: false,
    shareMode: "private",
  };
}

function fakeOrgFs(files: Map<string, string>) {
  const writes: { path: string; body: string; expect?: unknown }[] = [];
  const fs = {
    async listDir(_volume: string, path: string): Promise<OrgFsEntry[]> {
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${path}/`)) continue;
        const rest = key.slice(path.length + 1);
        const head = rest.split("/")[0];
        if (head) children.add(head);
      }
      if (children.size === 0) throw new Error("no such directory");
      return [...children].map((child) =>
        dirEntry(
          `${path}/${child}`,
          files.has(`${path}/${child}`) ? "file" : "dir",
        ),
      );
    },
    async read(_volume: string, path: string): Promise<Uint8Array> {
      const body = files.get(path);
      if (body === undefined) throw new Error("not found");
      return new TextEncoder().encode(body);
    },
    async write(
      _volume: string,
      path: string,
      body: string,
      opts: { expect?: unknown },
    ): Promise<OrgFsEntry> {
      if (
        opts.expect &&
        (opts.expect as { absent?: boolean }).absent &&
        files.has(path)
      ) {
        throw new Error("precondition failed");
      }
      writes.push({ path, body, expect: opts.expect });
      files.set(path, body);
      return dirEntry(path, "file");
    },
  };
  return { fs: fs as unknown as OrgFs, writes };
}

describe("parseAgentMd", () => {
  it("takes the name and description from the frontmatter", () => {
    const parsed = parseAgentMd(
      "redator",
      "---\nname: Redator\ndescription: Escreve o post\n---\n\nVocê escreve.",
    );
    expect(parsed).toEqual({
      slug: "redator",
      name: "Redator",
      description: "Escreve o post",
      body: "Você escreve.",
      tools: null,
    });
  });

  it("falls back to the slug and the first paragraph", () => {
    const parsed = parseAgentMd("pesquisador", "# Título\n\nVocê pesquisa.\n");
    expect(parsed.name).toBe("pesquisador");
    expect(parsed.description).toBe("Você pesquisa.");
    expect(parsed.body).toBe("# Título\n\nVocê pesquisa.");
  });

  it("reads the belt as a list, and nothing as every tool", () => {
    const belted = parseAgentMd(
      "ilustrador",
      "---\nname: X\ntools: BLOG_POST_ILLUSTRATE, generate_image\n---\n\nB.",
    );
    expect(belted.tools).toEqual(["BLOG_POST_ILLUSTRATE", "generate_image"]);
    expect(
      parseAgentMd("x", "---\nname: X\ntools:   \n---\n\nB.").tools,
    ).toBeNull();
  });

  it("round-trips through the file it renders", () => {
    const original = parseAgentMd(
      "x",
      "---\nname: Um\ndescription: Dois\ntools: A, B\n---\n\nTrês.",
    );
    expect(parseAgentMd("x", renderAgentMd(original))).toEqual(original);
  });
});

describe("readProjectAgent", () => {
  it("reads the project's own file", async () => {
    const { fs } = fakeOrgFs(
      new Map([
        [
          `${BASE}/pesquisador/AGENT.md`,
          "---\nname: Meu\n---\n\nMinhas regras.",
        ],
      ]),
    );
    const definition = await readProjectAgent(fs, PROJECT, "pesquisador");
    expect(definition?.name).toBe("Meu");
    expect(definition?.body).toBe("Minhas regras.");
  });

  it("is null for a role this project does not have", async () => {
    const { fs } = fakeOrgFs(new Map());
    expect(await readProjectAgent(fs, PROJECT, "pesquisador")).toBeNull();
  });

  it("refuses a slug that is not a folder name", async () => {
    const { fs } = fakeOrgFs(new Map());
    for (const slug of ["../escape", "Upper", "with/slash", ""]) {
      expect(await readProjectAgent(fs, PROJECT, slug)).toBeNull();
    }
  });
});

describe("listProjectAgents", () => {
  it("is empty for a project that has none", async () => {
    const { fs } = fakeOrgFs(new Map());
    expect(await listProjectAgents(fs, PROJECT)).toEqual([]);
  });

  it("lists what the folder holds, skipping what it cannot read", async () => {
    const { fs } = fakeOrgFs(
      new Map([
        [`${BASE}/pesquisador/AGENT.md`, "---\nname: Pesquisador\n---\n\nA."],
        [`${BASE}/redator/NOTES.md`, "not a definition"],
      ]),
    );
    const listed = await listProjectAgents(fs, PROJECT);
    expect(listed.map((d) => d.slug)).toEqual(["pesquisador"]);
  });
});

describe("seedProjectAgents", () => {
  it("writes the roster once, and never over an edited file", async () => {
    const files = new Map<string, string>();
    const { fs, writes } = fakeOrgFs(files);

    await seedProjectAgents(fs, PROJECT, "user_1");
    const seeded = writes.length;
    expect(seeded).toBeGreaterThan(0);
    expect(writes.every((w) => w.expect)).toBe(true);

    const edited = "---\nname: Meu\n---\n\nReescrito.";
    files.set(`${BASE}/pesquisador/AGENT.md`, edited);
    await seedProjectAgents(fs, PROJECT, "user_1");

    expect(writes).toHaveLength(seeded);
    expect(files.get(`${BASE}/pesquisador/AGENT.md`)).toBe(edited);
  });

  it("seeds the four roles the blog is written by", async () => {
    const { fs } = fakeOrgFs(new Map());
    await seedProjectAgents(fs, PROJECT, "user_1");
    const listed = await listProjectAgents(fs, PROJECT);
    expect(listed.map((d) => d.slug).sort()).toEqual([
      "estrategista",
      "ilustrador",
      "pesquisador",
      "redator",
    ]);
  });

  /**
   * A belt is an exclusive allowlist, so a role that names the wrong tool is a
   * role that silently cannot work. The researcher's null is the deliberate
   * one: reaching whatever the store connected is its whole job.
   */
  it("gives each role the belt it works with", async () => {
    const { fs } = fakeOrgFs(new Map());
    await seedProjectAgents(fs, PROJECT, "user_1");
    const bySlug = new Map(
      (await listProjectAgents(fs, PROJECT)).map((d) => [d.slug, d.tools]),
    );

    expect(bySlug.get("pesquisador")).toBeNull();
    expect(bySlug.get("redator")).toContain("BLOG_POST_WRITE");
    expect(bySlug.get("estrategista")).toContain("BLOG_CAMPAIGN_SUGGEST");
    expect(bySlug.get("ilustrador")).toEqual([
      "FILE_CONFIG_LIST",
      "BLOG_POST_ILLUSTRATE",
    ]);
  });

  it("seeds files the catalog can then read back", async () => {
    const { fs } = fakeOrgFs(new Map());
    await seedProjectAgents(fs, PROJECT, "user_1");
    const listed = await listProjectAgents(fs, PROJECT);
    expect(listed.length).toBeGreaterThan(0);
    for (const definition of listed) {
      expect(definition.name).not.toBe("");
      expect(definition.body.length).toBeGreaterThan(0);
    }
  });
});

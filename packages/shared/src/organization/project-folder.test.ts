import { describe, expect, test } from "bun:test";
import {
  folderNameFor,
  pinnedProjectFolderName,
  projectFolderDir,
  projectFolderName,
  projectFolderPath,
} from "./project-folder";

describe("folderNameFor", () => {
  test("folds accents rather than dropping them", () => {
    expect(folderNameFor("Ação Verão")).toBe("acao-verao");
  });

  test("collapses punctuation into single separators", () => {
    expect(folderNameFor("Acme · Loja  BR!")).toBe("acme-loja-br");
  });

  test("leaves no leading or trailing separator", () => {
    expect(folderNameFor("  — Outlet — ")).toBe("outlet");
  });

  /** A title with nothing nameable in it is what the id fallback is for. */
  test("is empty when nothing survives", () => {
    expect(folderNameFor("🌸")).toBe("");
  });
});

describe("projectFolderName", () => {
  test("derives from the title", () => {
    expect(projectFolderName({ id: "vir_1", title: "Acme Store" })).toBe(
      "acme-store",
    );
  });

  /** The pinned key names the PARENT, so it must not become the leaf — that is
   *  what made the sidebar's folder and the head's folder chip disagree. */
  test("a pinned parent does not rename the project's own folder", () => {
    expect(
      projectFolderName({
        id: "vir_1",
        title: "Acme Store",
        metadata: { project: { folder: "clientes" } },
      }),
    ).toBe("acme-store");
  });

  test("a pinned name survives a rename", () => {
    expect(
      projectFolderName({
        id: "vir_1",
        title: "Renamed",
        metadata: { projectFolderName: "acme-store" },
      }),
    ).toBe("acme-store");
  });

  test("ignores a pinned name that is not one safe segment", () => {
    for (const projectFolderName of ["..", ".", "a/b", "%2e%2e", " "]) {
      expect(
        pinnedProjectFolderName({
          id: "vir_1",
          metadata: { projectFolderName },
        }),
      ).toBeNull();
    }
  });

  test("falls back to the id so there is always somewhere to put a file", () => {
    expect(projectFolderName({ id: "vir_1", title: "🌸" })).toBe("vir_1");
  });
});

describe("projectFolderPath", () => {
  test("roots under the drive's projects folder", () => {
    expect(projectFolderPath({ id: "vir_1", title: "Acme Store" })).toBe(
      "home/projects/acme-store",
    );
  });

  test("nests under the folder a person put the project in", () => {
    expect(
      projectFolderPath({
        id: "vir_1",
        title: "Acme Store",
        metadata: { project: { folder: "clientes" } },
      }),
    ).toBe("home/projects/clientes/acme-store");
  });
});

describe("projectFolderDir", () => {
  test("is the browse path without the volume", () => {
    expect(projectFolderDir({ id: "vir_1", title: "Acme Store" })).toBe(
      "projects/acme-store",
    );
  });

  test("normalizes empty segments in the parent folder", () => {
    expect(
      projectFolderDir({
        id: "vir_1",
        title: "Acme Store",
        metadata: { project: { folder: "/Clients//2026/" } },
      }),
    ).toBe("projects/Clients/2026/acme-store");
  });

  test("ignores a parent folder that would leave projects/", () => {
    for (const folder of ["..", "../skills", "a/./b", "%2e%2e", "a\\b"]) {
      expect(
        projectFolderDir({
          id: "vir_1",
          title: "Acme Store",
          metadata: { project: { folder } },
        }),
      ).toBe("projects/acme-store");
    }
  });
});

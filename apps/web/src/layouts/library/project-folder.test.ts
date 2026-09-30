import { describe, expect, test } from "bun:test";
import {
  folderNameFor,
  projectFolderName,
  projectFolderPath,
} from "./project-folder";

describe("folderNameFor", () => {
  test("folds accents rather than dropping them", () => {
    expect(folderNameFor("Ação Verão")).toBe("acao-verao");
  });

  test("collapses punctuation into single separators", () => {
    expect(folderNameFor("Farm · Loja  BR!")).toBe("farm-loja-br");
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
    expect(projectFolderName({ id: "vir_1", title: "Farm BR" })).toBe(
      "farm-br",
    );
  });

  /** The pinned key names the PARENT, so it must not become the leaf — that is
   *  what made the sidebar's folder and the head's folder chip disagree. */
  test("a pinned parent does not rename the project's own folder", () => {
    expect(
      projectFolderName({
        id: "vir_1",
        title: "Farm BR",
        metadata: { project: { folder: "clientes" } },
      }),
    ).toBe("farm-br");
  });

  test("falls back to the id so there is always somewhere to put a file", () => {
    expect(projectFolderName({ id: "vir_1", title: "🌸" })).toBe("vir_1");
  });
});

describe("projectFolderPath", () => {
  test("roots under the drive's projects folder", () => {
    expect(projectFolderPath({ id: "vir_1", title: "Farm BR" })).toBe(
      "home/projects/farm-br",
    );
  });

  test("nests under the folder a person put the project in", () => {
    expect(
      projectFolderPath({
        id: "vir_1",
        title: "Farm BR",
        metadata: { project: { folder: "clientes" } },
      }),
    ).toBe("home/projects/clientes/farm-br");
  });
});

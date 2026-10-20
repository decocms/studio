import { describe, expect, it } from "bun:test";
import { isCardInVisibleProject } from "./project-scope";

const hidden = new Set(["vir_hidden"]);
const card = (overrides: {
  virtualMcpId?: string | null;
  repo?: string | null;
  threads?: { virtualMcpId: string | null }[];
}) => ({ virtualMcpId: null, repo: null, threads: [], ...overrides });

describe("isCardInVisibleProject", () => {
  it("shows every card when nothing is hidden", () => {
    expect(
      isCardInVisibleProject(new Set(), card({ virtualMcpId: "vir_hidden" })),
    ).toBe(true);
  });

  it("shows unfiled cards and cards in visible projects", () => {
    expect(isCardInVisibleProject(hidden, card({}))).toBe(true);
    expect(
      isCardInVisibleProject(
        hidden,
        card({ virtualMcpId: "vir_open", repo: "acme/site" }),
      ),
    ).toBe(true);
  });

  it("hides a card stamped for a hidden project", () => {
    expect(
      isCardInVisibleProject(hidden, card({ virtualMcpId: "vir_hidden" })),
    ).toBe(false);
  });

  it("hides a card whose repo holds a hidden project's id", () => {
    expect(isCardInVisibleProject(hidden, card({ repo: " vir_hidden " }))).toBe(
      false,
    );
  });

  it("hides a card with a thread under a hidden project", () => {
    expect(
      isCardInVisibleProject(
        hidden,
        card({
          virtualMcpId: "vir_open",
          threads: [{ virtualMcpId: null }, { virtualMcpId: "vir_hidden" }],
        }),
      ),
    ).toBe(false);
  });
});

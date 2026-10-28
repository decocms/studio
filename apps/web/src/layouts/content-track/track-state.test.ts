import { describe, expect, test } from "bun:test";
import {
  BRAND_BLOCK_KEY,
  CONTEXT_BLOCK_KEY,
} from "@/components/sandbox/content/blog/blog-data";
import { contentTrackGate, resolveExecuteTrack } from "./track-state";

const OPEN = {
  track: undefined,
  taskKey: undefined,
  boardOrg: undefined,
  projectFirstNav: true,
  blogAi: true,
  kanban: true,
} as const;

describe("resolveExecuteTrack", () => {
  test("the code track is the default", () => {
    expect(resolveExecuteTrack(OPEN)).toBe("code");
  });

  test("the URL picks the track", () => {
    expect(resolveExecuteTrack({ ...OPEN, track: "content" })).toBe("content");
    expect(resolveExecuteTrack({ ...OPEN, track: "code" })).toBe("code");
  });

  test("a task by its address, another tenant's board, the old navigation or the blog off: always code", () => {
    const content = { ...OPEN, track: "content" } as const;
    expect(resolveExecuteTrack({ ...content, taskKey: "DECO-1" })).toBe("code");
    expect(resolveExecuteTrack({ ...content, boardOrg: "other" })).toBe("code");
    expect(resolveExecuteTrack({ ...content, projectFirstNav: false })).toBe(
      "code",
    );
    expect(resolveExecuteTrack({ ...content, blogAi: false })).toBe("code");
  });

  test("waits for the blog flag before opening the content track", () => {
    expect(
      resolveExecuteTrack({ ...OPEN, track: "content", blogAi: undefined }),
    ).toBe("pending");
    expect(resolveExecuteTrack({ ...OPEN, blogAi: undefined })).toBe("code");
  });

  test("a plan without the board opens on content, once it is known", () => {
    expect(resolveExecuteTrack({ ...OPEN, kanban: false })).toBe("content");
    expect(resolveExecuteTrack({ ...OPEN, kanban: undefined })).toBe("pending");
    expect(
      resolveExecuteTrack({ ...OPEN, kanban: false, blogAi: undefined }),
    ).toBe("pending");
    expect(resolveExecuteTrack({ ...OPEN, kanban: false, track: "code" })).toBe(
      "code",
    );
  });
});

describe("contentTrackGate", () => {
  const BRAND = {
    companyName: "Aurora",
    language: "pt-BR",
    description: "Móveis",
  };
  const CONTEXT = {
    tone: "Calorosa",
    targetAudience: "Quem mora em apartamento",
    dos: [{ name: "Fale com você", value: "" }],
    avoid: [{ name: "Gírias", value: "" }],
  };

  test("waits while the brand is read", () => {
    expect(contentTrackGate({ ready: false, blocks: {} })).toEqual({
      gate: "loading",
    });
  });

  test("shows the setup, with what is missing, before the connections", () => {
    const state = contentTrackGate({
      ready: true,
      blocks: { [BRAND_BLOCK_KEY]: BRAND },
    });
    expect(state.gate).toBe("setup");
    expect(state.gate === "setup" && state.missing).toEqual([
      "tone",
      "targetAudience",
      "dos",
      "avoid",
    ]);
  });

  test("opens once the guide has what a post needs", () => {
    expect(
      contentTrackGate({
        ready: true,
        blocks: { [BRAND_BLOCK_KEY]: BRAND, [CONTEXT_BLOCK_KEY]: CONTEXT },
      }),
    ).toEqual({ gate: "open" });
  });
});

import { describe, expect, it } from "bun:test";
import {
  TASK_BOARD_ITEM_DELETED_EVENT,
  TASK_BOARD_ITEM_PRS_UPDATED_EVENT,
  TASK_BOARD_ITEM_UPDATED_EVENT,
} from "@decocms/shared/task-board";
import type { SSEEvent } from "../event-bus/sse-hub";
import { boardEventForListener, isCardInVisibleProject } from "./project-scope";

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

describe("boardEventForListener", () => {
  const event = (type: string, data: unknown): SSEEvent => ({
    id: "evt_1",
    type,
    source: "task-board",
    subject: "item_1",
    data,
    time: "2026-01-01T00:00:00.000Z",
  });
  const noCard = async () => null;

  it("passes every event through when nothing is hidden", async () => {
    const update = event(
      TASK_BOARD_ITEM_UPDATED_EVENT,
      card({ virtualMcpId: "vir_hidden" }),
    );
    expect(await boardEventForListener(new Set(), update, noCard)).toBe(update);
  });

  it("passes a visible card update through", async () => {
    const update = event(
      TASK_BOARD_ITEM_UPDATED_EVENT,
      card({ virtualMcpId: "vir_open" }),
    );
    expect(await boardEventForListener(hidden, update, noCard)).toBe(update);
  });

  it("turns a hidden card update into its deletion", async () => {
    const scoped = await boardEventForListener(
      hidden,
      event(TASK_BOARD_ITEM_UPDATED_EVENT, card({ repo: "vir_hidden" })),
      noCard,
    );
    expect(scoped?.type).toBe(TASK_BOARD_ITEM_DELETED_EVENT);
    expect(scoped?.data).toEqual({ id: "item_1" });
  });

  it("treats an update it cannot read as a deletion", async () => {
    const scoped = await boardEventForListener(
      hidden,
      event(TASK_BOARD_ITEM_UPDATED_EVENT, { title: "no attribution" }),
      noCard,
    );
    expect(scoped?.type).toBe(TASK_BOARD_ITEM_DELETED_EVENT);
  });

  it("drops a PR update for a hidden or missing card", async () => {
    const prs = event(TASK_BOARD_ITEM_PRS_UPDATED_EVENT, { prs: [] });
    expect(
      await boardEventForListener(hidden, prs, async () =>
        card({ virtualMcpId: "vir_hidden" }),
      ),
    ).toBeNull();
    expect(await boardEventForListener(hidden, prs, noCard)).toBeNull();
    expect(await boardEventForListener(hidden, prs, async () => card({}))).toBe(
      prs,
    );
  });

  it("passes other events through", async () => {
    const rules = event("task-board.rules.updated", {});
    expect(await boardEventForListener(hidden, rules, noCard)).toBe(rules);
  });
});

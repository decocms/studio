import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { KEYS } from "@/lib/query-keys";
import {
  initialProjectSidebarFormFields,
  optimisticProjectSidebarViewsNeedSave,
  projectSidebarFormFieldsForSave,
  readCachedVirtualMcp,
  settleOptimisticProjectSidebarViews,
  snapshotOptimisticProjectSidebarViews,
  stageOptimisticProjectSidebarViews,
  writeAuthoritativeVirtualMcpCaches,
} from "./optimistic-project-sidebar-views";

const ORG_ID = "org-1";
const PROJECT_ID = "project-1";

function project(
  id: string,
  sidebarViews: VirtualMCPEntity["metadata"]["sidebarViews"],
  sidebarViewsVersion: 1 | undefined,
): VirtualMCPEntity {
  return {
    id,
    title: id,
    description: null,
    icon: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: "user-1",
    organization_id: ORG_ID,
    status: "active",
    pinned: false,
    metadata: {
      instructions: null,
      sidebarViews,
      sidebarViewsVersion,
    },
    connections: [],
  };
}

function overlay(queryClient: QueryClient) {
  return queryClient.getQueryData<{
    revision: number;
    views: string[];
    rollbackViews: string[];
  }>(KEYS.optimisticProjectSidebarViews(ORG_ID, PROJECT_ID));
}

describe("optimistic project sidebar views", () => {
  test("an old queued form writes the newer pending revision", () => {
    const queryClient = new QueryClient();
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      ["overview"],
    );
    const newerPending = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["board", "automations"],
      ["overview"],
    );

    expect(
      projectSidebarFormFieldsForSave(
        {
          sidebarViews: ["assets"],
          sidebarViewsVersion: 1,
        },
        newerPending,
        project(PROJECT_ID, ["overview"], 1).metadata,
      ),
    ).toEqual({
      sidebarViews: ["board", "automations"],
      sidebarViewsVersion: 1,
    });
  });

  test("a remount seeds pending views then rebases an unrelated save after rollback", async () => {
    const queryClient = new QueryClient();
    const persisted = project(PROJECT_ID, ["assets"], undefined);
    const pending = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["board"],
      ["overview", "reports", "board", "site-editor", "assets"],
    );

    const remountedFields = initialProjectSidebarFormFields(
      persisted.metadata,
      pending,
    );
    expect(remountedFields).toEqual({
      sidebarViews: ["board"],
      sidebarViewsVersion: 1,
    });

    await settleOptimisticProjectSidebarViews(queryClient, ORG_ID, PROJECT_ID, {
      snapshot: pending,
      saved: false,
      authoritativeViews: [
        "overview",
        "reports",
        "board",
        "site-editor",
        "assets",
      ],
    });
    const rebasedFields = projectSidebarFormFieldsForSave(
      remountedFields,
      snapshotOptimisticProjectSidebarViews(queryClient, ORG_ID, PROJECT_ID),
      persisted.metadata,
    );

    expect(rebasedFields).toEqual({
      sidebarViews: ["assets"],
      sidebarViewsVersion: undefined,
    });
  });

  test("writes a successful response through item and list caches", () => {
    const queryClient = new QueryClient();
    const client = {};
    const original = project(PROJECT_ID, ["overview"], 1);
    const other = project("project-2", ["board"], 1);
    const updated = project(PROJECT_ID, ["assets", "automations"], 1);
    const itemKey = KEYS.collectionItem(
      client,
      ORG_ID,
      "",
      "VIRTUAL_MCP",
      PROJECT_ID,
    );
    const listKey = KEYS.collectionList(
      client,
      ORG_ID,
      "",
      "VIRTUAL_MCP",
      "page-1",
    );
    queryClient.setQueryData<{ item: VirtualMCPEntity }>(itemKey, {
      item: original,
    });
    queryClient.setQueryData<{
      structuredContent: { items: VirtualMCPEntity[] };
    }>(listKey, {
      structuredContent: { items: [original, other] },
    });

    writeAuthoritativeVirtualMcpCaches(queryClient, ORG_ID, updated);

    expect(readCachedVirtualMcp(queryClient, ORG_ID, PROJECT_ID)).toEqual(
      updated,
    );
    expect(
      queryClient.getQueryData<{ item: VirtualMCPEntity }>(itemKey),
    ).toEqual({ item: updated });
    expect(
      queryClient.getQueryData<{
        structuredContent: { items: VirtualMCPEntity[] };
      }>(listKey),
    ).toEqual({
      structuredContent: { items: [updated, other] },
    });
  });

  test("rapid changes retain the persisted rollback value", () => {
    const queryClient = new QueryClient();

    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      ["site-editor"],
    );
    const latest = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets", "hosting"],
      ["site-editor", "automations"],
    );

    expect(latest).toEqual({
      revision: 2,
      views: ["assets", "hosting"],
      persistedViews: ["site-editor"],
    });
    expect(overlay(queryClient)).toEqual({
      revision: 2,
      views: ["assets", "hosting"],
      rollbackViews: ["site-editor"],
    });
  });

  test("an older successful save advances rollback without clearing newer UI", async () => {
    const queryClient = new QueryClient();
    const older = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      [],
    );
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets", "hosting"],
      [],
    );
    const settlement = await settleOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      {
        snapshot: older,
        saved: true,
        authoritativeViews: ["assets"],
      },
    );

    expect(settlement.settledLatest).toBe(false);
    expect(overlay(queryClient)).toEqual({
      revision: 2,
      views: ["assets", "hosting"],
      rollbackViews: ["assets"],
    });
  });

  test("a failed latest save clears the overlay and returns the authoritative rollback", async () => {
    const queryClient = new QueryClient();
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      ["site-editor"],
    );
    const snapshot = snapshotOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
    );
    const settlement = await settleOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      {
        snapshot,
        saved: false,
        authoritativeViews: ["board"],
      },
    );

    expect(settlement).toEqual({
      settledLatest: true,
      reconciledViews: ["board"],
    });
    expect(overlay(queryClient)).toBeNull();
  });

  test("a newer change prevents a stale settlement", async () => {
    const queryClient = new QueryClient();
    const snapshot = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      [],
    );
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["hosting"],
      [],
    );

    const settlement = await settleOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      {
        snapshot,
        saved: true,
        authoritativeViews: ["assets"],
      },
    );

    expect(settlement).toEqual({
      settledLatest: false,
      reconciledViews: null,
    });
    expect(overlay(queryClient)?.views).toEqual(["hosting"]);
    expect(overlay(queryClient)?.rollbackViews).toEqual(["assets"]);
  });

  test("a stale failed save adopts refreshed persistence without clearing newer UI", async () => {
    const queryClient = new QueryClient();
    const stale = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      ["overview"],
    );
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["hosting"],
      ["overview"],
    );

    const settlement = await settleOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      {
        snapshot: stale,
        saved: false,
        authoritativeViews: ["board"],
      },
    );

    expect(settlement).toEqual({
      settledLatest: false,
      reconciledViews: null,
    });
    expect(overlay(queryClient)?.views).toEqual(["hosting"]);
    expect(overlay(queryClient)?.rollbackViews).toEqual(["board"]);
  });

  test("requires a write when RHF is clean but the latest revision is unconfirmed", () => {
    const queryClient = new QueryClient();
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      [],
    );
    const snapshot = snapshotOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
    );

    expect(optimisticProjectSidebarViewsNeedSave(snapshot)).toBe(true);
  });

  test("does not write a semantic on-off no-op", () => {
    const queryClient = new QueryClient();
    stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["automations", "overview"],
      ["overview", "automations", "overview"],
    );
    const snapshot = snapshotOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
    );

    expect(optimisticProjectSidebarViewsNeedSave(snapshot)).toBe(false);
  });

  test("successful normalization reconciles the form to the returned value", async () => {
    const queryClient = new QueryClient();
    const snapshot = stageOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      ["assets"],
      [],
    );

    const settlement = await settleOptimisticProjectSidebarViews(
      queryClient,
      ORG_ID,
      PROJECT_ID,
      {
        snapshot,
        saved: true,
        authoritativeViews: ["overview"],
      },
    );

    expect(settlement).toEqual({
      settledLatest: true,
      reconciledViews: ["overview"],
    });
    expect(overlay(queryClient)).toBeNull();
  });
});

import { setupComponentTest } from "../../../test/setup";
setupComponentTest();

import { afterAll, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderBare } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realChat from "@/components/chat/chat-context";
import * as realBackend from "@/components/sections-editor/use-content-backend";
import * as realDecofile from "@/components/sections-editor/use-decofile";
import * as realLiveMeta from "@/components/sections-editor/use-live-meta";
import * as realMembers from "@/hooks/use-members";
import * as realSdk from "@/sdk";
import * as realNavigate from "./use-panel-navigate";

// The reconcile window of an A/B test or campaign save is shown outside the
// project's screens and names who made the other change from the members
// already read: the Experiments and Calendar views read them (hosted v8).
const asked: Array<boolean | undefined> = [];
let backend: Record<string, unknown> = { kind: "pending" };

const restore = [
  ["@/components/chat/chat-context", { ...realChat }],
  ["@/components/sections-editor/use-content-backend", { ...realBackend }],
  ["@/components/sections-editor/use-decofile", { ...realDecofile }],
  ["@/components/sections-editor/use-live-meta", { ...realLiveMeta }],
  ["@/hooks/use-members", { ...realMembers }],
  ["@/sdk", { ...realSdk }],
  ["./use-panel-navigate", { ...realNavigate }],
] as const;
afterAll(() => {
  for (const [path, real] of restore) mock.module(path, () => real);
});

mock.module("@/components/chat/chat-context", () => ({
  ...realChat,
  useOptionalChatTask: () => ({ currentBranch: "draft-1", taskId: null }),
}));
mock.module("@/components/sections-editor/use-content-backend", () => ({
  ...realBackend,
  useContentBackend: () => backend,
}));
mock.module("@/components/sections-editor/use-decofile", () => ({
  ...realDecofile,
  useDecofile: () => ({ data: undefined, isError: false }),
}));
mock.module("@/components/sections-editor/use-live-meta", () => ({
  ...realLiveMeta,
  useLiveMeta: () => ({ data: undefined, isError: false }),
}));
mock.module("@/hooks/use-members", () => ({
  ...realMembers,
  useMembersQuery: (opts?: { enabled?: boolean }) => {
    asked.push(opts?.enabled);
    return { data: undefined };
  },
}));
mock.module("@/sdk", () => ({
  ...realSdk,
  useProjectContext: () => ({ org: { id: "org-1", slug: "acme" } }),
}));
mock.module("./use-panel-navigate", () => ({
  ...realNavigate,
  usePanelNavigate: () => ({ openPanel: () => {} }),
}));

const { SiteDraftView } = await import("./site-draft-view");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function view() {
  return renderBare(
    <SiteDraftView
      virtualMcpId="vm-1"
      icon={null}
      copy={{
        noDraftTitle: "no draft",
        noDraftDesc: "",
        loadFailed: "failed",
        loadFailedHint: "",
      }}
      skeleton={<div>loading</div>}
    >
      {() => <div>ready</div>}
    </SiteDraftView>,
    { wrapper },
  );
}

describe("SiteDraftView (Experiments and Calendar)", () => {
  test("reads the org's members on a hosted v8 draft, so the reconcile window names who changed it", () => {
    asked.length = 0;
    backend = { kind: "protocol", source: "github" };
    view().unmount();
    expect(asked).toContain(true);
  });

  test("reads nothing for Localhost or a site still loading", () => {
    for (const other of [
      { kind: "protocol", source: "local" },
      { kind: "pending" },
    ]) {
      asked.length = 0;
      backend = other;
      view().unmount();
      expect(asked.every((enabled) => enabled === false)).toBe(true);
    }
  });
});

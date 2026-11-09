import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import * as realRouter from "@tanstack/react-router";
import type { ReactNode } from "react";
import * as realChatLayout from "@/components/chat-layout";
import * as realDraftActions from "@/components/site-draft-bar/site-draft-actions";
import * as realV8 from "@/hooks/use-blocks-v8-project";
import * as realApp from "@/layouts/main-panel-tabs/experiments-app";
import * as realThreadRoute from "@/layouts/thread-route";
import * as realSdk from "@/sdk";

let v8 = false;

const restore = {
  router: { ...realRouter },
  chatLayout: { ...realChatLayout },
  draftActions: { ...realDraftActions },
  v8: { ...realV8 },
  app: { ...realApp },
  threadRoute: { ...realThreadRoute },
  sdk: { ...realSdk },
};
afterAll(() => {
  mock.module("@tanstack/react-router", () => restore.router);
  mock.module("@/components/chat-layout", () => restore.chatLayout);
  mock.module(
    "@/components/site-draft-bar/site-draft-actions",
    () => restore.draftActions,
  );
  mock.module("@/hooks/use-blocks-v8-project", () => restore.v8);
  mock.module("@/layouts/main-panel-tabs/experiments-app", () => restore.app);
  mock.module("@/layouts/thread-route", () => restore.threadRoute);
  mock.module("@/sdk", () => restore.sdk);
});

mock.module("@tanstack/react-router", () => ({
  ...restore.router,
  Navigate: (props: {
    to: string;
    params: Record<string, string>;
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
    replace?: boolean;
  }) => (
    <div
      data-testid="navigate"
      data-to={props.to}
      data-params={JSON.stringify(props.params)}
      data-search={JSON.stringify(
        props.search({ thread: "t-1", test: "hero", sidepanel: true }),
      )}
      data-replace={String(!!props.replace)}
    />
  ),
}));
mock.module("@/components/chat-layout", () => ({
  ...restore.chatLayout,
  ChatLayout: {
    Content: ({
      actions,
      children,
    }: {
      actions?: ReactNode;
      children: ReactNode;
    }) => (
      <div>
        <div data-testid="actions">{actions}</div>
        {children}
      </div>
    ),
  },
}));
mock.module("@/components/site-draft-bar/site-draft-actions", () => ({
  ...restore.draftActions,
  SiteDraftActions: ({ blocksOnly }: { blocksOnly?: boolean }) => (
    <div data-testid="draft-bar" data-blocks-only={String(!!blocksOnly)} />
  ),
}));
mock.module("@/hooks/use-blocks-v8-project", () => ({
  ...restore.v8,
  useBlocksV8Project: () => v8,
}));
mock.module("@/layouts/main-panel-tabs/experiments-app", () => ({
  ...restore.app,
  ExperimentsApp: ({ virtualMcpId }: { virtualMcpId: string }) => (
    <div data-testid="experiments-app">{virtualMcpId}</div>
  ),
}));
mock.module("@/layouts/thread-route", () => ({
  ...restore.threadRoute,
  useRouteVirtualMcpId: () => "vm-1",
}));
mock.module("@/sdk", () => ({
  ...restore.sdk,
  useProjectContext: () => ({ org: { slug: "acme" } }),
}));

const { default: AgentExperimentsRoute } = await import("./agent-experiments");

beforeEach(() => {
  v8 = false;
});

describe("the Experiments app's route", () => {
  test("a Blocks v8 project gets the app, under the site's draft bar", () => {
    v8 = true;
    const body = within(render(<AgentExperimentsRoute />).container);
    expect(body.getByTestId("experiments-app").textContent).toBe("vm-1");
    expect(body.queryByTestId("navigate")).toBeNull();
    expect(body.getByTestId("draft-bar").getAttribute("data-blocks-only")).toBe(
      "true",
    );
  });

  test("any other project goes to Monitor's Experiments view, replacing the entry", () => {
    const body = within(render(<AgentExperimentsRoute />).container);
    expect(body.queryByTestId("experiments-app")).toBeNull();
    const to = body.getByTestId("navigate");
    expect(to.getAttribute("data-to")).toBe(
      "/$org/projects/$agentId/monitoring",
    );
    expect(JSON.parse(to.getAttribute("data-params")!)).toEqual({
      org: "acme",
      agentId: "vm-1",
    });
    // The thread stays; the v8-only `test` doesn't follow.
    expect(JSON.parse(to.getAttribute("data-search")!)).toEqual({
      thread: "t-1",
      sidepanel: true,
      view: "experiments",
    });
    expect(to.getAttribute("data-replace")).toBe("true");
    // Nothing of the app mounts first: no layout actions, no draft bar.
    expect(body.queryByTestId("actions")).toBeNull();
    expect(body.queryByTestId("draft-bar")).toBeNull();
  });
});

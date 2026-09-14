import { setupComponentTest } from "../../../../../test/setup";

setupComponentTest();

import { describe, expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import {
  CodeWorkspaceProvider,
  type CodeWorkspaceIdentity,
  codeWorkspaceIdentityKey,
  useCodeWorkspace,
} from "./code-workspace-context";

const FIRST_IDENTITY: CodeWorkspaceIdentity = {
  orgSlug: "acme",
  virtualMcpId: "storefront",
  branch: "draft/alex",
  threadId: "thread-1",
};

function WorkspaceProbe() {
  const workspace = useCodeWorkspace();
  const [identityChanges, setIdentityChanges] = useState(0);
  const path = "/src/page.tsx";
  const buffer = workspace.buffers.get(path);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          workspace.updateOpenTabs(() => [path]);
          workspace.setSelectedFile(path);
          workspace.setSelectedTreeNode({
            name: "page.tsx",
            path,
            kind: "file",
            children: [],
          });
          workspace.setCompactPane("editor");
          workspace.setBuffers(
            new Map([
              [
                path,
                {
                  savedContent: "saved",
                  editorValue: "draft",
                  loaded: true,
                },
              ],
            ]),
          );
          workspace.setFileErrors(
            new Map([[path, { kind: "write", message: "offline" }]]),
          );
        }}
      >
        Create draft
      </button>
      <button
        type="button"
        onClick={() =>
          workspace.requestIdentityChange(() =>
            setIdentityChanges((current) => current + 1),
          )
        }
      >
        Change identity
      </button>
      <button type="button" onClick={workspace.cancelIdentityChange}>
        Cancel identity change
      </button>
      <button type="button" onClick={workspace.discardActiveSession}>
        Discard active session
      </button>
      <button
        type="button"
        onClick={workspace.discardAndContinueIdentityChange}
      >
        Discard and change
      </button>
      <output data-testid="selected-file">{workspace.selectedFile}</output>
      <output data-testid="selected-tree-node">
        {workspace.selectedTreeNode?.path}
      </output>
      <output data-testid="open-tabs">{workspace.openTabs.join(",")}</output>
      <output data-testid="draft">{buffer?.editorValue}</output>
      <output data-testid="error">
        {workspace.fileErrors.get(path)?.message}
      </output>
      <output data-testid="compact-pane">{workspace.compactPane}</output>
      <output data-testid="identity-change-pending">
        {String(workspace.identityChangePending)}
      </output>
      <output data-testid="identity-changes">{identityChanges}</output>
      <output data-testid="has-unsaved-changes">
        {String(workspace.hasUnsavedChanges)}
      </output>
    </div>
  );
}

function Harness({
  identity,
  codeMounted,
}: {
  identity: CodeWorkspaceIdentity;
  codeMounted: boolean;
}) {
  return (
    <CodeWorkspaceProvider identity={identity}>
      {codeMounted ? <WorkspaceProbe /> : <div>Preview route</div>}
    </CodeWorkspaceProvider>
  );
}

describe("CodeWorkspaceProvider", () => {
  it("preserves an editing session while Site Editor child routes swap", () => {
    const screen = render(
      <Harness identity={FIRST_IDENTITY} codeMounted={true} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    screen.rerender(<Harness identity={FIRST_IDENTITY} codeMounted={false} />);
    expect(screen.getByText("Preview route")).toBeInTheDocument();

    screen.rerender(<Harness identity={FIRST_IDENTITY} codeMounted={true} />);
    expect(screen.getByTestId("selected-file")).toHaveTextContent(
      "/src/page.tsx",
    );
    expect(screen.getByTestId("selected-tree-node")).toHaveTextContent(
      "/src/page.tsx",
    );
    expect(screen.getByTestId("open-tabs")).toHaveTextContent("/src/page.tsx");
    expect(screen.getByTestId("draft")).toHaveTextContent("draft");
    expect(screen.getByTestId("error")).toHaveTextContent("offline");
    expect(screen.getByTestId("compact-pane")).toHaveTextContent("editor");
  });

  it("isolates identities without destroying the previous editing session", () => {
    const screen = render(
      <Harness identity={FIRST_IDENTITY} codeMounted={true} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    screen.rerender(
      <Harness
        identity={{ ...FIRST_IDENTITY, branch: "draft/sam" }}
        codeMounted={true}
      />,
    );

    expect(screen.getByTestId("selected-file")).toBeEmptyDOMElement();
    expect(screen.getByTestId("selected-tree-node")).toBeEmptyDOMElement();
    expect(screen.getByTestId("open-tabs")).toBeEmptyDOMElement();
    expect(screen.getByTestId("draft")).toBeEmptyDOMElement();
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(screen.getByTestId("compact-pane")).toHaveTextContent("tree");
    expect(screen.getByTestId("has-unsaved-changes")).toHaveTextContent("true");

    screen.rerender(<Harness identity={FIRST_IDENTITY} codeMounted={true} />);
    expect(screen.getByTestId("selected-file")).toHaveTextContent(
      "/src/page.tsx",
    );
    expect(screen.getByTestId("open-tabs")).toHaveTextContent("/src/page.tsx");
    expect(screen.getByTestId("draft")).toHaveTextContent("draft");
    expect(screen.getByTestId("error")).toHaveTextContent("offline");
  });

  it("confirms before an in-place identity change can discard a draft", () => {
    const screen = render(
      <Harness identity={FIRST_IDENTITY} codeMounted={true} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Change identity" }));
    expect(screen.getByTestId("identity-change-pending")).toHaveTextContent(
      "true",
    );
    expect(screen.getByTestId("identity-changes")).toHaveTextContent("0");

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel identity change" }),
    );
    expect(screen.getByTestId("identity-change-pending")).toHaveTextContent(
      "false",
    );
    expect(screen.getByTestId("draft")).toHaveTextContent("draft");

    fireEvent.click(screen.getByRole("button", { name: "Change identity" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and change" }));
    expect(screen.getByTestId("identity-changes")).toHaveTextContent("1");
    expect(screen.getByTestId("draft")).toBeEmptyDOMElement();
  });

  it("discards only the active retained identity for router navigation", () => {
    const secondIdentity = { ...FIRST_IDENTITY, threadId: "thread-2" };
    const screen = render(
      <Harness identity={FIRST_IDENTITY} codeMounted={true} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Discard active session" }),
    );
    screen.rerender(<Harness identity={secondIdentity} codeMounted={true} />);
    expect(screen.getByTestId("has-unsaved-changes")).toHaveTextContent(
      "false",
    );

    screen.rerender(<Harness identity={FIRST_IDENTITY} codeMounted={true} />);
    expect(screen.getByTestId("draft")).toBeEmptyDOMElement();
    expect(screen.getByTestId("open-tabs")).toBeEmptyDOMElement();
  });

  it("uses unambiguous tuple identities", () => {
    expect(
      codeWorkspaceIdentityKey({
        orgSlug: "one:two",
        virtualMcpId: "three",
        branch: null,
        threadId: null,
      }),
    ).not.toBe(
      codeWorkspaceIdentityKey({
        orgSlug: "one",
        virtualMcpId: "two:three",
        branch: null,
        threadId: null,
      }),
    );
  });
});

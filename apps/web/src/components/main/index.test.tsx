import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { Main } from ".";

function MainFrame({ children }: { children: ReactNode }) {
  return (
    <Main>
      <Main.Topbar>
        <Main.Topbar.Left>
          <Main.Topbar.Left.Target />
        </Main.Topbar.Left>
        <Main.Topbar.Center>
          <Main.Topbar.Center.Target />
        </Main.Topbar.Center>
        <Main.Topbar.Right>
          <Main.Topbar.Right.Target />
        </Main.Topbar.Right>
      </Main.Topbar>
      <Main.Toolbar />
      <Main.Content>{children}</Main.Content>
    </Main>
  );
}

describe("Main", () => {
  it("portals route-owned controls into each topbar region", async () => {
    const { findByText } = render(
      <MainFrame>
        <Main.Topbar.Left.Portal>
          <span>Left control</span>
        </Main.Topbar.Left.Portal>
        <Main.Topbar.Center.Portal>
          <span>Center control</span>
        </Main.Topbar.Center.Portal>
        <Main.Topbar.Right.Portal>
          <span>Right control</span>
        </Main.Topbar.Right.Portal>
      </MainFrame>,
    );

    expect(
      (await findByText("Left control")).closest("[data-slot]"),
    ).toHaveAttribute("data-slot", "main-topbar-left-portal-target");
    expect(
      (await findByText("Center control")).closest("[data-slot]"),
    ).toHaveAttribute("data-slot", "main-topbar-center-portal-target");
    expect(
      (await findByText("Right control")).closest("[data-slot]"),
    ).toHaveAttribute("data-slot", "main-topbar-right-portal-target");
  });

  it("composes compact and persistent toolbar contributions", async () => {
    const { findByText, getByText } = render(
      <MainFrame>
        <Main.Toolbar.Portal visibility="compact">
          <span>Compact navigation</span>
        </Main.Toolbar.Portal>
        <Main.Toolbar.Portal>
          <span>Persistent filters</span>
        </Main.Toolbar.Portal>
      </MainFrame>,
    );

    const compactContent = (await findByText("Compact navigation")).closest(
      '[data-slot="main-toolbar-portal-content"]',
    );
    const persistentContent = getByText("Persistent filters").closest(
      '[data-slot="main-toolbar-portal-content"]',
    );
    const toolbar = getByText("Persistent filters").closest(
      '[data-slot="main-toolbar"]',
    );

    expect(compactContent).toHaveAttribute(
      "data-toolbar-visibility",
      "compact",
    );
    expect(compactContent).toHaveClass("md:hidden");
    expect(persistentContent).toHaveAttribute(
      "data-toolbar-visibility",
      "always",
    );
    expect(toolbar).not.toHaveClass("md:hidden");
  });

  it("hides a toolbar from desktop when every contribution is compact", async () => {
    const { findByText } = render(
      <MainFrame>
        <Main.Toolbar.Portal visibility="compact">
          <span>Compact only</span>
        </Main.Toolbar.Portal>
      </MainFrame>,
    );

    expect(
      (await findByText("Compact only")).closest('[data-slot="main-toolbar"]'),
    ).toHaveClass("md:hidden");
  });

  it("makes scroll ownership and content measure explicit", () => {
    const { getByTestId } = render(
      <Main>
        <Main.Content mode="canvas" data-testid="content">
          <Main.Container
            width="reading"
            padding="compact"
            data-testid="container"
          >
            Content
          </Main.Container>
        </Main.Content>
      </Main>,
    );

    expect(getByTestId("content")).toHaveAttribute("data-mode", "canvas");
    expect(getByTestId("content")).toHaveClass("overflow-hidden");
    expect(getByTestId("container")).toHaveAttribute("data-width", "reading");
    expect(getByTestId("container")).toHaveAttribute("data-padding", "compact");
    expect(getByTestId("container")).toHaveClass("max-w-3xl");
  });

  it("keeps one h1 while overlapping route titles hand off to the newest owner", async () => {
    function TitleFrame({ next }: { next: boolean }) {
      return (
        <StrictMode>
          <Main>
            <Main.Topbar>
              <Main.Topbar.Left>
                <Main.Title>
                  <Main.Title.Target fallback="Fallback" />
                </Main.Title>
              </Main.Topbar.Left>
            </Main.Topbar>
            <Main.Content>
              <Main.Title.Portal>Previous title</Main.Title.Portal>
              {next ? <Main.Title.Portal>Next title</Main.Title.Portal> : null}
            </Main.Content>
          </Main>
        </StrictMode>
      );
    }

    const { getByRole, getAllByRole, queryByRole, rerender } = render(
      <TitleFrame next />,
    );
    await waitFor(() =>
      expect(
        getByRole("heading", { level: 1, name: "Next title" }),
      ).toBeVisible(),
    );

    expect(
      queryByRole("heading", { level: 1, name: "Previous title" }),
    ).not.toBeInTheDocument();
    expect(getAllByRole("heading", { level: 1 })).toHaveLength(1);

    rerender(<TitleFrame next={false} />);
    await waitFor(() =>
      expect(
        getByRole("heading", { level: 1, name: "Previous title" }),
      ).toBeVisible(),
    );
    expect(getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("restores the prior breadcrumb contributor after an overlap", async () => {
    function BreadcrumbFrame({ next }: { next: boolean }) {
      return (
        <Main>
          <Main.Breadcrumb.Parent.Target>
            {({ present, target }) => (
              <div data-testid="breadcrumb-target" data-present={present}>
                {target}
              </div>
            )}
          </Main.Breadcrumb.Parent.Target>
          <Main.Breadcrumb.Parent.Portal>
            <button type="button">Previous parent</button>
          </Main.Breadcrumb.Parent.Portal>
          {next ? (
            <Main.Breadcrumb.Parent.Portal>
              <button type="button">Next parent</button>
            </Main.Breadcrumb.Parent.Portal>
          ) : null}
        </Main>
      );
    }

    const { getByRole, getByTestId, queryByRole, rerender } = render(
      <BreadcrumbFrame next />,
    );
    await waitFor(() =>
      expect(getByRole("button", { name: "Next parent" })).toBeVisible(),
    );

    expect(
      queryByRole("button", { name: "Previous parent" }),
    ).not.toBeInTheDocument();
    expect(getByTestId("breadcrumb-target")).toHaveAttribute(
      "data-present",
      "true",
    );

    rerender(<BreadcrumbFrame next={false} />);
    await waitFor(() =>
      expect(getByRole("button", { name: "Previous parent" })).toBeVisible(),
    );
  });
});

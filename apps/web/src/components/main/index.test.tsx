import { setupComponentTest } from "../../../test/setup";

setupComponentTest();

import "@testing-library/jest-dom";
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import { Main } from "./index";

describe("Main compound layout", () => {
  it("portals content into each topbar and subheader slot exactly once", () => {
    const { getByTestId, getByRole } = render(
      <Main>
        <Main.Topbar>
          <Main.Topbar.Left data-testid="left-slot">
            <span>Left anchor</span>
            <Main.Topbar.Left.Target />
          </Main.Topbar.Left>
          <Main.Topbar.Center data-testid="center-slot">
            <Main.Topbar.Center.Target />
          </Main.Topbar.Center>
          <Main.Topbar.Right data-testid="right-slot">
            <Main.Topbar.Right.Target />
          </Main.Topbar.Right>
        </Main.Topbar>
        <Main.Subheader data-testid="subheader-slot" />
        <Main.Content>
          <Main.Topbar.Left.Portal>
            <button type="button" data-testid="left-portal">
              Left action
            </button>
          </Main.Topbar.Left.Portal>
          <Main.Topbar.Center.Portal>
            <span data-testid="center-portal">Center status</span>
          </Main.Topbar.Center.Portal>
          <Main.Topbar.Right.Portal>
            <button type="button" data-testid="right-portal">
              Right action
            </button>
          </Main.Topbar.Right.Portal>
          <Main.Subheader.Portal>
            <nav aria-label="Section" data-testid="subheader-portal">
              Section navigation
            </nav>
          </Main.Subheader.Portal>
        </Main.Content>
      </Main>,
    );

    const leftSlot = getByTestId("left-slot");
    const centerSlot = getByTestId("center-slot");
    const rightSlot = getByTestId("right-slot");
    const subheaderSlot = getByTestId("subheader-slot");

    expect(leftSlot).toContainElement(getByTestId("left-portal"));
    expect(centerSlot).toContainElement(getByTestId("center-portal"));
    expect(rightSlot).toContainElement(getByTestId("right-portal"));
    expect(subheaderSlot).toContainElement(getByTestId("subheader-portal"));

    expect(within(leftSlot).getByRole("button", { name: "Left action" })).toBe(
      getByTestId("left-portal"),
    );
    expect(
      within(rightSlot).getByRole("button", { name: "Right action" }),
    ).toBe(getByTestId("right-portal"));
    expect(getByRole("navigation", { name: "Section" })).toBe(
      getByTestId("subheader-portal"),
    );

    for (const testId of [
      "left-portal",
      "center-portal",
      "right-portal",
      "subheader-portal",
    ]) {
      expect(
        document.querySelectorAll(`[data-testid="${testId}"]`),
      ).toHaveLength(1);
    }
  });

  it("detaches portal content with its target and restores it into a new target", () => {
    function PortalLifecycle({ targets }: { targets: boolean }) {
      return (
        <Main>
          {targets ? (
            <>
              <Main.Topbar>
                <Main.Topbar.Left data-testid="lifecycle-left">
                  <Main.Topbar.Left.Target />
                </Main.Topbar.Left>
              </Main.Topbar>
              <Main.Subheader data-testid="lifecycle-subheader" />
            </>
          ) : null}
          <Main.Content>
            <Main.Topbar.Left.Portal
              fallback={<span data-testid="left-fallback">No topbar</span>}
            >
              <button type="button" data-testid="lifecycle-action">
                Run
              </button>
            </Main.Topbar.Left.Portal>
            <Main.Subheader.Portal>
              <span data-testid="lifecycle-navigation">Navigation</span>
            </Main.Subheader.Portal>
          </Main.Content>
        </Main>
      );
    }

    const view = render(<PortalLifecycle targets />);

    expect(view.getByTestId("lifecycle-left")).toContainElement(
      view.getByTestId("lifecycle-action"),
    );
    expect(view.getByTestId("lifecycle-subheader")).toContainElement(
      view.getByTestId("lifecycle-navigation"),
    );
    expect(view.queryByTestId("left-fallback")).not.toBeInTheDocument();

    view.rerender(<PortalLifecycle targets={false} />);

    expect(view.queryByTestId("lifecycle-action")).not.toBeInTheDocument();
    expect(view.queryByTestId("lifecycle-navigation")).not.toBeInTheDocument();
    expect(view.getByTestId("left-fallback")).toBeInTheDocument();

    view.rerender(<PortalLifecycle targets />);

    expect(view.getByTestId("lifecycle-left")).toContainElement(
      view.getByTestId("lifecycle-action"),
    );
    expect(view.getAllByTestId("lifecycle-action")).toHaveLength(1);
    expect(view.queryByTestId("left-fallback")).not.toBeInTheDocument();
  });

  it("places route contributions before fixed workspace actions in keyboard order", () => {
    const { getByTestId } = render(
      <Main>
        <Main.Topbar>
          <Main.Topbar.Right data-testid="route-actions">
            <Main.Topbar.Right.Target />
            <button type="button">Route action</button>
            <button type="button">Collapse Main</button>
          </Main.Topbar.Right>
        </Main.Topbar>
        <Main.Content>
          <Main.Topbar.Right.Portal>
            <button type="button">New item</button>
          </Main.Topbar.Right.Portal>
        </Main.Content>
      </Main>,
    );

    expect(
      within(getByTestId("route-actions"))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["New item", "Route action", "Collapse Main"]);
  });

  it("rejects duplicate live portal targets for one region", () => {
    expect(() =>
      render(
        <Main>
          <Main.Topbar>
            <Main.Topbar.Right>
              <Main.Topbar.Right.Target />
              <Main.Topbar.Right.Target />
            </Main.Topbar.Right>
          </Main.Topbar>
        </Main>,
      ),
    ).toThrow("Main.right can only have one live portal target");
  });

  it("fails clearly when a slot or portal is rendered outside Main", () => {
    expect(() =>
      render(<Main.Topbar.Left>Orphan slot</Main.Topbar.Left>),
    ).toThrow("Main slot components must be used inside <Main>");

    expect(() =>
      render(
        <Main.Topbar.Right.Portal>Orphan portal</Main.Topbar.Right.Portal>,
      ),
    ).toThrow("Main slot components must be used inside <Main>");
  });
});

import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { CollectionTabs } from "./collection-tabs";

describe("CollectionTabs", () => {
  it("exposes a named view switcher without claiming an unrelated tabpanel", () => {
    const onTabChange = mock();
    const { getByRole, queryByRole } = render(
      <CollectionTabs
        ariaLabel="Results view"
        tabs={[
          { id: "all", label: "All" },
          { id: "connected", label: "Connected" },
        ]}
        activeTab="all"
        onTabChange={onTabChange}
      />,
    );

    expect(getByRole("toolbar", { name: "Results view" })).toBeVisible();
    expect(getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(queryByRole("tablist")).not.toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: "Connected" }));
    expect(onTabChange).toHaveBeenCalledWith("connected");
  });

  it("moves toolbar focus with arrow keys without changing the view", () => {
    const onTabChange = mock();
    const { getByRole } = render(
      <CollectionTabs
        ariaLabel="Results view"
        tabs={[
          { id: "all", label: "All" },
          { id: "connected", label: "Connected" },
        ]}
        activeTab="all"
        onTabChange={onTabChange}
      />,
    );
    const all = getByRole("button", { name: "All" });
    const connected = getByRole("button", { name: "Connected" });

    all.focus();
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(connected).toHaveFocus();
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

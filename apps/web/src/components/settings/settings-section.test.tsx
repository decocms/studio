import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { SettingsCardItem } from "./settings-section";

describe("SettingsCardItem", () => {
  it("keeps its primary action and trailing control as sibling buttons", () => {
    const onOpen = mock();
    const onToggle = mock();
    const { getByRole, getAllByRole } = render(
      <SettingsCardItem
        title="Community registry"
        description="Public integrations"
        onClick={onOpen}
        action={
          <button type="button" onClick={onToggle}>
            Enable
          </button>
        }
      />,
    );

    const buttons = getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.contains(buttons[1] ?? null)).toBe(false);

    fireEvent.click(getByRole("button", { name: "Enable" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(
      getByRole("button", {
        name: "Community registry Public integrations",
      }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

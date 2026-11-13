import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ItemActions } from "./item-actions";

function open(actions: React.ComponentProps<typeof ItemActions>) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ItemActions {...actions} />
    </QueryClientProvider>,
  );
  fireEvent.keyDown(view.getByRole("button", { name: "More actions" }), {
    key: "Enter",
  });
  const items = () =>
    view.getAllByRole("menuitem").map((item) => item.textContent);
  return { view, items };
}

describe("ItemActions", () => {
  test("Discard changes sits before Delete and runs its own action", () => {
    const onDiscard = mock();
    const onDelete = mock();
    const { view, items } = open({ onDiscard, onDelete });
    expect(items()).toEqual(["Discard changes", "Delete"]);
    fireEvent.click(view.getByRole("menuitem", { name: "Discard changes" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  test("without a discard, the menu offers only what it was given", () => {
    const { items } = open({ onRename: () => {}, onDelete: () => {} });
    expect(items()).toEqual(["Rename", "Delete"]);
  });

  test("a menu can discard without offering Delete", () => {
    const { items } = open({ onDiscard: () => {} });
    expect(items()).toEqual(["Discard changes"]);
  });
});

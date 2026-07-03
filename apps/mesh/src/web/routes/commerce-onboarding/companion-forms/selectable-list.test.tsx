import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SelectableList } from "./selectable-list.tsx";

describe("SelectableList", () => {
  it("constrains long option labels so they truncate inside the row", () => {
    const longLabel =
      "https://www.example.com/a/very/long/google/search/console/site/url/that/should/not/stretch/the/dialog";

    const { getByRole, getByText } = render(
      <SelectableList
        options={[{ value: "site", label: longLabel }]}
        value="site"
        onChange={() => {}}
        ariaLabel="Site verificado"
      />,
    );

    expect(getByRole("radio", { name: longLabel })).toHaveClass("min-w-0");
    expect(getByText(longLabel)).toHaveClass("min-w-0", "flex-1", "truncate");
  });
});
